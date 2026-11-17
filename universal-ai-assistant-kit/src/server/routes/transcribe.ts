import { Router, type Response } from 'express';
import { GoogleGenAI } from '@google/genai';
import multer from 'multer';
import type { AuthedRequest } from '../auth.ts';
import { checkAndConsumeAiCredit } from '../billing/checkAndConsume.ts';
import type { OrgCreditStore } from '../billing/creditStore.ts';
import { logger, type ServerConfig } from '../config.ts';
import { extractAccessScope } from '../security/scope.ts';

export function createTranscribeRouter(params: {
  cfg: ServerConfig;
  creditStore?: OrgCreditStore;
}): Router {
  const router = Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 12 * 1024 * 1024, files: 1 },
  });

  router.post(
    '/',
    upload.single('audio'),
    async (req: AuthedRequest, res: Response): Promise<void> => {
      try {
        const scope = await extractAccessScope(req, params.cfg, {
          defaultUnauthenticatedRole: params.cfg.requireAuth ? 'PUBLIC' : 'ADMIN',
        });
        if (scope.role === 'PUBLIC') {
          res.status(403).json({
            error: 'Please sign in to use voice transcription.',
            errorCode: 'AUTH_REQUIRED',
          });
          return;
        }

        if (params.creditStore?.isBillingEnabled) {
          const gate = await checkAndConsumeAiCredit({
            creditStore: params.creditStore,
            scope,
            actionType: 'voice',
            res,
          });
          if (!gate.allowed) return;
        }

        let audioBuffer: Buffer | null = null;
        let mimeType = 'audio/webm';
        const language =
          typeof req.body?.language === 'string' && req.body.language ? req.body.language : undefined;

        if (req.file?.buffer?.length) {
          audioBuffer = req.file.buffer;
          mimeType = req.file.mimetype || 'audio/webm';
        } else if (typeof req.body?.audioBase64 === 'string' && req.body.audioBase64.trim()) {
          const raw = req.body.audioBase64.trim();
          const dataMatch = /^data:([^;]+);base64,(.+)$/.exec(raw);
          if (dataMatch) {
            mimeType = dataMatch[1] || mimeType;
            audioBuffer = Buffer.from(dataMatch[2], 'base64');
          } else {
            audioBuffer = Buffer.from(raw, 'base64');
            if (typeof req.body?.mimeType === 'string' && req.body.mimeType) {
              mimeType = req.body.mimeType;
            }
          }
        }

        if (!audioBuffer || audioBuffer.length === 0) {
          res.status(400).json({ error: 'Missing audio payload for transcription.' });
          return;
        }

        if (params.cfg.geminiApiKey) {
          try {
            const ai = new GoogleGenAI({ apiKey: params.cfg.geminiApiKey });
            const prompt =
              language === 'ml'
                ? 'Transcribe the spoken audio accurately (Malayalam or English). Return only the transcript text.'
                : 'Transcribe the spoken audio accurately in its original language (English or Malayalam). Return only the transcript text.';

            const response = await ai.models.generateContent({
              model: params.cfg.geminiModelTranscribe || 'gemini-2.5-flash',
              contents: [
                {
                  role: 'user',
                  parts: [
                    { text: prompt },
                    {
                      inlineData: {
                        mimeType,
                        data: audioBuffer.toString('base64'),
                      },
                    },
                  ],
                },
              ],
            });
            const text = (response.text || '').trim();
            if (text) {
              res.json({ text, provider: 'gemini' });
              return;
            }
          } catch (err) {
            logger.warn({ err }, 'Gemini transcription failed; trying Groq Whisper');
          }
        }

        if (params.cfg.groqApiKey) {
          try {
            const ext = mimeType.includes('mp4')
              ? 'mp4'
              : mimeType.includes('wav')
                ? 'wav'
                : mimeType.includes('ogg')
                  ? 'ogg'
                  : 'webm';
            const form = new FormData();
            form.append('model', params.cfg.groqModelTranscribe || 'whisper-large-v3-turbo');
            form.append(
              'file',
              new Blob([new Uint8Array(audioBuffer)], { type: mimeType }),
              `voice.${ext}`
            );
            if (language === 'en' || language === 'ml') {
              form.append('language', language);
            }

            const groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${params.cfg.groqApiKey}`,
              },
              body: form,
            });
            if (groqRes.ok) {
              const json = (await groqRes.json()) as { text?: string };
              const text = (json.text || '').trim();
              if (text) {
                res.json({ text, provider: 'groq' });
                return;
              }
            }
          } catch (err) {
            logger.warn({ err }, 'Groq audio transcription fallback failed');
          }
        }

        res.status(503).json({
          error: 'Voice transcription is unavailable because no configured audio provider succeeded.',
        });
      } catch (err) {
        logger.error({ err }, 'Unexpected error in /transcribe');
        res.status(500).json({ error: 'Audio transcription error.' });
      }
    }
  );

  return router;
}
