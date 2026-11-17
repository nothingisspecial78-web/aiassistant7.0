import crypto from 'node:crypto';
import { Router, type Response } from 'express';
import multer from 'multer';
import {
  ALLOWED_MULTIMODAL_EXTENSIONS,
  ALLOWED_SPREADSHEET_EXTENSIONS,
  MAX_CHAT_ATTACHMENTS,
  type ChatAttachment,
  type ImportPreviewResult,
  type SheetTemplate,
} from '../../core/index.ts';
import type { AuthedRequest } from '../auth.ts';
import { checkAndConsumeAiCredit } from '../billing/checkAndConsume.ts';
import type { OrgCreditStore } from '../billing/creditStore.ts';
import { logger, type ServerConfig } from '../config.ts';
import { inspectFileMagicBytes } from '../files/magicBytes.ts';
import { parseUploadedDocument } from '../files/parseDocument.ts';
import { parseSpreadsheetBuffer } from '../files/parseSheet.ts';
import {
  generateErrorReportCsv,
  generateErrorReportXlsxBuffer,
  validateSpreadsheetRows,
} from '../files/validate.ts';
import type { ProfileRegistry } from '../profiles/loader.ts';
import { createConfirmationToken, type ActionLogStore } from '../security/confirmation.ts';
import { validateExtensionAndMime } from '../security/sanitize.ts';
import { extractAccessScope } from '../security/scope.ts';

function resolveTemplateForApp(
  profiles: ProfileRegistry,
  appId: string,
  headers: string[],
  rows: Array<Record<string, unknown>>,
  totalRows: number,
  explicitTemplateId?: string,
  columnOverrides: Record<string, string> = {}
): SheetTemplate | null {
  if (explicitTemplateId) {
    return profiles.getTemplate(appId, explicitTemplateId) || null;
  }
  const allTemplates = profiles.getTemplates(appId);
  if (allTemplates.length === 0) return null;
  if (allTemplates.length === 1) return allTemplates[0];

  let bestTpl = allTemplates[0];
  let bestScore = -1;
  for (const cand of allTemplates) {
    const probe = validateSpreadsheetRows({
      uploadId: 'probe',
      appId,
      fileName: 'probe.xlsx',
      template: cand,
      headers,
      rows: rows.slice(0, 5),
      totalRows,
      truncated: false,
      columnOverrides,
    });
    const reqCols = cand.columns.filter((c) => c.required);
    const matchedReq = reqCols.filter((rc) =>
      probe.columnMapping.some((m) => m.expectedKey === rc.key && m.confidence !== 'missing')
    ).length;
    const matchedAll = probe.columnMapping.filter((m) => m.confidence !== 'missing').length;
    const score = matchedReq * 10 + matchedAll * 2 + (reqCols.length > 0 && matchedReq === reqCols.length ? 20 : 0);
    if (score > bestScore) {
      bestScore = score;
      bestTpl = cand;
    }
  }
  return bestTpl;
}

function buildPendingImportPreview(params: {
  cfg: ServerConfig;
  actionStore: ActionLogStore;
  appId: string;
  userId: string;
  uploadId: string;
  fileName: string;
  targetArea: string;
  template: SheetTemplate;
  headers: string[];
  rows: Array<Record<string, unknown>>;
  totalRows: number;
  truncated: boolean;
  sheetNames: string[];
  selectedSheet: string;
  headerRowIndex: number;
  columnOverrides: Record<string, string>;
}): ImportPreviewResult {
  const preview = validateSpreadsheetRows({
    uploadId: params.uploadId,
    appId: params.appId,
    fileName: params.fileName,
    template: params.template,
    headers: params.headers,
    rows: params.rows,
    totalRows: params.totalRows,
    truncated: params.truncated,
    columnOverrides: params.columnOverrides,
    sheetNames: params.sheetNames,
    selectedSheet: params.selectedSheet,
    headerRowIndex: params.headerRowIndex,
  });

  const requiredKeys = new Set(
    params.template.columns.filter((c) => c.required).map((c) => c.key)
  );
  const missingRequiredColumns = preview.columnMapping
    .filter((m) => requiredKeys.has(m.expectedKey) && m.confidence === 'missing')
    .map((m) => m.expectedLabel);

  const formatMatched =
    missingRequiredColumns.length === 0 &&
    preview.totalRows > 0 &&
    preview.validCount > 0;

  preview.formatMatched = formatMatched;
  preview.missingRequiredColumns = missingRequiredColumns;

  if (formatMatched) {
    const actionId = `act_${crypto.randomUUID()}`;
    const toolArgs = {
      uploadId: params.uploadId,
      fileName: params.fileName,
      validCount: preview.validCount,
      targetArea: params.targetArea || params.template.templateId,
      sheetName: params.selectedSheet,
    };
    const { token } = createConfirmationToken(
      {
        actionId,
        appId: params.appId,
        userId: params.userId,
        toolName: params.template.targetTool,
        args: toolArgs,
      },
      params.cfg.confirmationSecret
    );

    params.actionStore.savePendingAction(
      {
        id: actionId,
        appId: params.appId,
        userId: params.userId,
        toolName: params.template.targetTool,
        risk: 'write',
        status: 'pending',
        summary: `Import ${preview.validCount} valid row(s) via "${params.template.name}" from "${params.fileName}" (${preview.invalidCount} skipped)`,
        args: toolArgs,
        createdIds: [],
        createdAt: new Date().toISOString(),
      },
      toolArgs
    );

    preview.actionId = actionId;
    preview.confirmationToken = token;
  }

  params.actionStore.saveUploadPreview(preview);
  return preview;
}

export function createUploadRouter(params: {
  cfg: ServerConfig;
  profiles: ProfileRegistry;
  actionStore: ActionLogStore;
  creditStore?: OrgCreditStore;
}): Router {
  const router = Router();

  const spreadsheetUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: params.cfg.maxUploadBytes,
      files: 1,
    },
  });

  const multimodalUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: params.cfg.maxUploadBytes,
      files: MAX_CHAT_ATTACHMENTS,
    },
  });

  // 1. Spreadsheet import preview & validation
  router.post(
    '/',
    spreadsheetUpload.single('file'),
    async (req: AuthedRequest, res: Response): Promise<void> => {
      const profile = req.appProfile || params.profiles.getDefaultProfile();
      const authUser = req.authUser || { userId: 'default-user', rawToken: '' };

      const file = req.file;
      if (!file) {
        res.status(400).json({ error: 'Missing spreadsheet file under field "file".' });
        return;
      }

      const check = validateExtensionAndMime(file.originalname, file.mimetype);
      if (
        !check.valid ||
        !(ALLOWED_SPREADSHEET_EXTENSIONS as readonly string[]).includes(check.ext)
      ) {
        res.status(400).json({ error: check.reason || 'Unsupported spreadsheet format.' });
        return;
      }

      const magic = inspectFileMagicBytes(file.buffer, file.originalname, file.mimetype);
      if (!magic.valid) {
        res.status(400).json({ error: magic.reason || 'File signature validation failed.' });
        return;
      }

      const scope = await extractAccessScope(req, params.cfg, {
        defaultUnauthenticatedRole: params.cfg.requireAuth ? 'PUBLIC' : 'ADMIN',
      });
      if (scope.role === 'PUBLIC') {
        res.status(403).json({
          error: 'Please sign in before importing spreadsheets.',
          errorCode: 'AUTH_REQUIRED',
        });
        return;
      }

      if (params.creditStore?.isBillingEnabled) {
        const gate = await checkAndConsumeAiCredit({
          creditStore: params.creditStore,
          scope,
          actionType: 'attachment',
          res,
        });
        if (!gate.allowed) return;
      }

      const targetAreaRaw =
        typeof req.body?.targetArea === 'string' ? req.body.targetArea.trim().toLowerCase() : '';
      const explicitTemplateId =
        typeof req.body?.templateId === 'string' && req.body.templateId
          ? req.body.templateId
          : undefined;
      const requestedSheet =
        typeof req.body?.sheetName === 'string' && req.body.sheetName.trim()
          ? req.body.sheetName.trim()
          : undefined;

      let columnOverrides: Record<string, string> = {};
      if (typeof req.body?.columnOverrides === 'string' && req.body.columnOverrides.trim()) {
        try {
          columnOverrides = JSON.parse(req.body.columnOverrides) as Record<string, string>;
        } catch {
          res.status(400).json({ error: 'Invalid JSON in columnOverrides.' });
          return;
        }
      }

      try {
        const parsed = parseSpreadsheetBuffer(
          file.buffer,
          file.originalname,
          params.cfg.uploadMaxRows,
          { sheetName: requestedSheet }
        );

        const template = resolveTemplateForApp(
          params.profiles,
          profile.appId,
          parsed.headers,
          parsed.rows,
          parsed.totalRows,
          explicitTemplateId,
          columnOverrides
        );

        if (!template) {
          res.status(400).json({
            error: `No spreadsheet import template configured for app "${profile.appId}"${explicitTemplateId ? ` (${explicitTemplateId})` : ''}. Attach the spreadsheet via chat instead or register a SheetTemplate.`,
          });
          return;
        }

        const uploadId = `upl_${crypto.randomUUID()}`;
        params.actionStore.saveUploadRawFile(
          uploadId,
          file.buffer,
          file.originalname,
          file.mimetype
        );

        const preview = buildPendingImportPreview({
          cfg: params.cfg,
          actionStore: params.actionStore,
          appId: profile.appId,
          userId: authUser.userId,
          uploadId,
          fileName: file.originalname,
          targetArea: targetAreaRaw,
          template,
          headers: parsed.headers,
          rows: parsed.rows,
          totalRows: parsed.totalRows,
          truncated: parsed.truncated,
          sheetNames: parsed.sheetNames,
          selectedSheet: parsed.selectedSheet,
          headerRowIndex: parsed.headerRowIndex,
          columnOverrides,
        });

        res.json(preview);
      } catch (err) {
        logger.error({ err, appId: profile.appId }, 'Spreadsheet parsing failed');
        res.status(400).json({
          error: err instanceof Error ? err.message : 'Failed to parse spreadsheet file.',
        });
      }
    }
  );

  // 2. Revalidate an uploaded spreadsheet with updated sheet/columnOverrides
  router.post('/:uploadId/revalidate', async (req: AuthedRequest, res: Response): Promise<void> => {
    const profile = req.appProfile || params.profiles.getDefaultProfile();
    const authUser = req.authUser || { userId: 'default-user', rawToken: '' };

    const uploadId = String(req.params.uploadId);
    const rawFile = params.actionStore.getUploadRawFile(uploadId);
    const existingPreview = params.actionStore.getUploadPreview(uploadId);
    if (!rawFile || !existingPreview) {
      res.status(404).json({ error: 'Original upload buffer expired or not found.' });
      return;
    }

    const body = (req.body || {}) as {
      sheetName?: string;
      columnOverrides?: Record<string, string>;
      targetArea?: string;
    };

    try {
      const parsed = parseSpreadsheetBuffer(
        rawFile.buffer,
        rawFile.fileName,
        params.cfg.uploadMaxRows,
        { sheetName: body.sheetName || existingPreview.selectedSheet }
      );

      const template =
        resolveTemplateForApp(
          params.profiles,
          profile.appId,
          parsed.headers,
          parsed.rows,
          parsed.totalRows,
          existingPreview.templateId,
          body.columnOverrides || {}
        ) || params.profiles.getTemplate(profile.appId, existingPreview.templateId);

      if (!template) {
        res.status(400).json({ error: 'Import template not found.' });
        return;
      }

      const preview = buildPendingImportPreview({
        cfg: params.cfg,
        actionStore: params.actionStore,
        appId: profile.appId,
        userId: authUser.userId,
        uploadId,
        fileName: rawFile.fileName,
        targetArea: (body.targetArea || template.templateId).trim().toLowerCase(),
        template,
        headers: parsed.headers,
        rows: parsed.rows,
        totalRows: parsed.totalRows,
        truncated: parsed.truncated,
        sheetNames: parsed.sheetNames,
        selectedSheet: parsed.selectedSheet,
        headerRowIndex: parsed.headerRowIndex,
        columnOverrides: body.columnOverrides || {},
      });

      res.json(preview);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Revalidation failed.',
      });
    }
  });

  // 3. Multimodal general file upload (images, PDF, DOCX, TXT, JSON, MD, spreadsheets)
  router.post(
    '/file',
    multimodalUpload.array('files', MAX_CHAT_ATTACHMENTS),
    async (req: AuthedRequest, res: Response): Promise<void> => {
      const profile = req.appProfile || params.profiles.getDefaultProfile();
      const authUser = req.authUser || { userId: 'default-user', rawToken: '' };

      const files = (req.files as Express.Multer.File[]) || [];
      if (files.length === 0) {
        res.status(400).json({ error: 'Missing files under field "files".' });
        return;
      }

      for (const file of files) {
        const extCheck = validateExtensionAndMime(file.originalname, file.mimetype);
        if (
          !extCheck.valid ||
          !(ALLOWED_MULTIMODAL_EXTENSIONS as readonly string[]).includes(extCheck.ext)
        ) {
          res.status(400).json({ error: extCheck.reason || 'Unsupported attachment type.' });
          return;
        }
        const magic = inspectFileMagicBytes(file.buffer, file.originalname, file.mimetype);
        if (!magic.valid) {
          res.status(400).json({
            error: magic.reason || `Invalid file signature for "${file.originalname}".`,
          });
          return;
        }
      }

      const scope = await extractAccessScope(req, params.cfg, {
        defaultUnauthenticatedRole: params.cfg.requireAuth ? 'PUBLIC' : 'ADMIN',
      });
      if (scope.role === 'PUBLIC') {
        res.status(403).json({
          error: 'Please sign in before uploading files or screenshots.',
          errorCode: 'AUTH_REQUIRED',
        });
        return;
      }

      if (params.creditStore?.isBillingEnabled) {
        const gate = await checkAndConsumeAiCredit({
          creditStore: params.creditStore,
          scope,
          actionType: 'attachment',
          res,
        });
        if (!gate.allowed) return;
      }

      const conversationId =
        typeof req.body?.conversationId === 'string' && req.body.conversationId.trim()
          ? req.body.conversationId.trim()
          : 'default';

      try {
        const attachments: ChatAttachment[] = [];

        for (const file of files) {
          const lower = file.originalname.toLowerCase();
          const isSpreadsheet = ALLOWED_SPREADSHEET_EXTENSIONS.some((ext) => lower.endsWith(ext));

          if (isSpreadsheet) {
            const parsedSheet = parseSpreadsheetBuffer(
              file.buffer,
              file.originalname,
              Math.min(params.cfg.uploadMaxRows, 500)
            );
            const uploadId = `upl_${crypto.randomUUID()}`;
            params.actionStore.saveUploadRawFile(
              uploadId,
              file.buffer,
              file.originalname,
              file.mimetype
            );

            const template = resolveTemplateForApp(
              params.profiles,
              profile.appId,
              parsedSheet.headers,
              parsedSheet.rows,
              parsedSheet.totalRows
            );
            if (template) {
              buildPendingImportPreview({
                cfg: params.cfg,
                actionStore: params.actionStore,
                appId: profile.appId,
                userId: authUser.userId,
                uploadId,
                fileName: file.originalname,
                targetArea: '',
                template,
                headers: parsedSheet.headers,
                rows: parsedSheet.rows,
                totalRows: parsedSheet.totalRows,
                truncated: parsedSheet.truncated,
                sheetNames: parsedSheet.sheetNames,
                selectedSheet: parsedSheet.selectedSheet,
                headerRowIndex: parsedSheet.headerRowIndex,
                columnOverrides: {},
              });
            }

            const sampleCsvLines = [
              parsedSheet.headers.join(', '),
              ...parsedSheet.rows
                .slice(0, 25)
                .map((r) => parsedSheet.headers.map((h) => String(r[h] ?? '')).join(', ')),
            ].join('\n');

            attachments.push({
              type: 'file',
              name: file.originalname,
              mimeType: file.mimetype || 'text/csv',
              uploadId,
              sizeBytes: file.buffer.length,
              sheetNames: parsedSheet.sheetNames,
              selectedSheet: parsedSheet.selectedSheet,
              previewSummary: `${parsedSheet.selectedSheet || 'Sheet'} · ${parsedSheet.totalRows} row(s), ${parsedSheet.headers.length} columns`,
              extractedText: sampleCsvLines.slice(0, 20000),
            });
            continue;
          }

          const parsedDoc = await parseUploadedDocument({
            buffer: file.buffer,
            filename: file.originalname,
            mimeType: file.mimetype,
            geminiApiKey: params.cfg.geminiApiKey,
            conversationId,
          });

          const isImg =
            /\.(png|jpg|jpeg|webp|gif|heic)$/i.test(lower) ||
            file.mimetype.startsWith('image/');
          attachments.push({
            type: isImg ? 'image' : 'file',
            name: file.originalname,
            mimeType: file.mimetype || (isImg ? 'image/jpeg' : 'application/octet-stream'),
            dataUrl: isImg ? parsedDoc.dataUrl : undefined,
            sizeBytes: parsedDoc.sizeBytes,
            pageCount: parsedDoc.pageCount,
            geminiFileUri: parsedDoc.geminiFileUri,
            extractedText: parsedDoc.extractedText,
            sha256: parsedDoc.sha256,
            previewSummary: parsedDoc.previewSummary,
          });
        }

        res.json({ ok: true, attachments });
      } catch (err) {
        logger.error({ err, appId: profile.appId }, 'Multimodal upload failed');
        res.status(400).json({
          error: err instanceof Error ? err.message : 'Failed to process uploaded file(s).',
        });
      }
    }
  );

  // 4. Error report downloads (.csv & .xlsx)
  router.get('/:uploadId/errors.csv', (req: AuthedRequest, res: Response) => {
    const uploadId = String(req.params.uploadId);
    const preview = params.actionStore.getUploadPreview(uploadId);
    if (!preview) {
      res.status(404).json({ error: 'Upload preview not found.' });
      return;
    }

    const csv = generateErrorReportCsv(preview.errors);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="import-errors-${uploadId}.csv"`);
    res.send(csv);
  });

  router.get('/:uploadId/errors.xlsx', async (req: AuthedRequest, res: Response) => {
    const uploadId = String(req.params.uploadId);
    const preview = params.actionStore.getUploadPreview(uploadId);
    if (!preview) {
      res.status(404).json({ error: 'Upload preview not found.' });
      return;
    }

    try {
      const xlsxBuf = await generateErrorReportXlsxBuffer(preview.errors);
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="import-errors-${uploadId}.xlsx"`
      );
      res.send(xlsxBuf);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to generate Excel error report.',
      });
    }
  });

  return router;
}
