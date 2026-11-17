import crypto from 'node:crypto';
import type { ActionLogEntry, ImportPreviewResult } from '../../core/index.ts';

interface PendingActionInternal {
  entry: ActionLogEntry;
  rawArgs: Record<string, unknown>;
}

export class ActionLogStore {
  private readonly actions = new Map<string, ActionLogEntry>();
  private readonly pendingRawArgs = new Map<string, Record<string, unknown>>();
  private readonly idempotencyResults = new Map<string, { payload: unknown; expiresAt: number }>();
  private readonly uploadPreviews = new Map<string, { preview: ImportPreviewResult; expiresAt: number }>();
  private readonly uploadRawFiles = new Map<string, { buffer: Buffer; fileName: string; mimeType: string; expiresAt: number }>();

  savePendingAction(entry: ActionLogEntry, rawArgs?: Record<string, unknown>): void {
    this.actions.set(entry.id, entry);
    if (rawArgs) {
      this.pendingRawArgs.set(entry.id, rawArgs);
    }
  }

  getPendingArgs(actionId: string): Record<string, unknown> | undefined {
    return this.pendingRawArgs.get(actionId);
  }

  recordImmediateAction(entry: ActionLogEntry): void {
    this.actions.set(entry.id, entry);
  }

  getAction(actionId: string): ActionLogEntry | undefined {
    return this.actions.get(actionId);
  }

  updateAction(actionId: string, patch: Partial<ActionLogEntry>): ActionLogEntry | undefined {
    const existing = this.actions.get(actionId);
    if (!existing) return undefined;
    const updated: ActionLogEntry = { ...existing, ...patch };
    this.actions.set(actionId, updated);
    if (patch.status && patch.status !== 'pending') {
      this.pendingRawArgs.delete(actionId);
    }
    return updated;
  }

  listActions(appId: string, userId?: string): ActionLogEntry[] {
    const list: ActionLogEntry[] = [];
    for (const entry of this.actions.values()) {
      if (entry.appId !== appId) continue;
      if (userId && entry.userId !== userId && entry.userId !== 'default-user') continue;
      list.push(entry);
    }
    return list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 100);
  }

  getExecutedIdempotencyResult(key: string): Record<string, unknown> | null {
    const entry = this.idempotencyResults.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.idempotencyResults.delete(key);
      return null;
    }
    return entry.payload as Record<string, unknown>;
  }

  recordExecutedIdempotencyResult(key: string, payload: unknown, ttlMs = 10 * 60 * 1000): void {
    this.idempotencyResults.set(key, {
      payload,
      expiresAt: Date.now() + ttlMs,
    });
  }

  saveUploadPreview(preview: ImportPreviewResult, ttlMs = 30 * 60 * 1000): void {
    this.uploadPreviews.set(preview.uploadId, {
      preview,
      expiresAt: Date.now() + ttlMs,
    });
  }

  getUploadPreview(uploadId: string): ImportPreviewResult | undefined {
    const entry = this.uploadPreviews.get(uploadId);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.uploadPreviews.delete(uploadId);
      return undefined;
    }
    return entry.preview;
  }

  saveUploadRawFile(
    uploadId: string,
    buffer: Buffer,
    fileName: string,
    mimeType: string,
    ttlMs = 30 * 60 * 1000
  ): void {
    this.uploadRawFiles.set(uploadId, {
      buffer,
      fileName,
      mimeType,
      expiresAt: Date.now() + ttlMs,
    });
  }

  getUploadRawFile(
    uploadId: string
  ): { buffer: Buffer; fileName: string; mimeType: string } | undefined {
    const entry = this.uploadRawFiles.get(uploadId);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.uploadRawFiles.delete(uploadId);
      return undefined;
    }
    return {
      buffer: entry.buffer,
      fileName: entry.fileName,
      mimeType: entry.mimeType,
    };
  }
}

export function createConfirmationToken(
  payload: {
    actionId: string;
    appId: string;
    userId: string;
    toolName: string;
    args: Record<string, unknown>;
  },
  secret: string,
  ttlSeconds = 600
): { token: string; expiresAt: string } {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const body = {
    actionId: payload.actionId,
    appId: payload.appId,
    userId: payload.userId,
    toolName: payload.toolName,
    argsHash: crypto
      .createHash('sha256')
      .update(JSON.stringify(payload.args || {}))
      .digest('hex')
      .slice(0, 16),
    exp,
  };
  const encoded = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return {
    token: `${encoded}.${sig}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

export function verifyConfirmationToken(
  token: string,
  expected: { actionId: string; appId: string; userId: string },
  secret: string
): { valid: boolean; reason?: string } {
  const parts = token.split('.');
  if (parts.length !== 2) {
    return { valid: false, reason: 'Malformed confirmation token.' };
  }
  const [encoded, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');

  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return { valid: false, reason: 'Invalid confirmation token signature.' };
  }

  try {
    const decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as {
      actionId: string;
      appId: string;
      userId: string;
      exp: number;
    };
    if (decoded.exp * 1000 < Date.now()) {
      return { valid: false, reason: 'Confirmation token has expired.' };
    }
    if (decoded.actionId !== expected.actionId || decoded.appId !== expected.appId) {
      return { valid: false, reason: 'Confirmation token scope mismatch.' };
    }
    if (
      decoded.userId !== expected.userId &&
      expected.userId !== 'default-user' &&
      decoded.userId !== 'default-user'
    ) {
      return { valid: false, reason: 'Confirmation token user mismatch.' };
    }
    return { valid: true };
  } catch {
    return { valid: false, reason: 'Corrupt confirmation token payload.' };
  }
}

export type { PendingActionInternal };
