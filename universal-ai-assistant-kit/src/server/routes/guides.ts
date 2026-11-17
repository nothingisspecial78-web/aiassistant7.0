import { Router, type Response } from 'express';
import type { AuthedRequest } from '../auth.ts';
import type { ServerConfig } from '../config.ts';
import type { GuideService } from '../guides/guideService.ts';
import { extractAccessScope } from '../security/scope.ts';

const ttsAudioCache = new Map<string, Buffer>();

function createFallbackWav(text: string): Buffer {
  const sampleRate = 22050;
  const durationSec = Math.min(Math.max(text.length * 0.06, 0.8), 6);
  const numSamples = Math.floor(sampleRate * durationSec);
  const headerSize = 44;
  const dataSize = numSamples * 2;
  const buffer = Buffer.alloc(headerSize + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const env = Math.sin((Math.PI * i) / numSamples);
    const freq = 220 + Math.sin(t * 12) * 40;
    const sample = Math.sin(2 * Math.PI * freq * t) * 0.28 * env;
    const intSample = Math.max(-32768, Math.min(32767, Math.floor(sample * 32767)));
    buffer.writeInt16LE(intSample, headerSize + i * 2);
  }

  return buffer;
}

export function createGuidesRouter(deps: {
  cfg: ServerConfig;
  guideService: GuideService;
}): Router {
  const router = Router();
  const defaultRole = deps.cfg.requireAuth ? 'PUBLIC' : 'ADMIN';

  router.get('/', async (req: AuthedRequest, res: Response) => {
    const scope = await extractAccessScope(req, deps.cfg, {
      defaultUnauthenticatedRole: defaultRole,
    }).catch(() => null);
    const guides = deps.guideService.getGuidesForScope(scope);
    res.json({
      ok: true,
      guides: guides.map((g) => ({
        guideId: g.guideId,
        title: g.title,
        summary: g.summary,
        keywords: g.keywords,
        roles: g.roles,
        startRoute: g.startRoute,
        stepCount: g.steps.length,
      })),
    });
  });

  router.get('/search', async (req: AuthedRequest, res: Response) => {
    const q = String(req.query.q || '');
    const scope = await extractAccessScope(req, deps.cfg, {
      defaultUnauthenticatedRole: defaultRole,
    }).catch(() => null);
    const matches = deps.guideService.searchGuides(q, scope, 8);
    res.json({ ok: true, matches });
  });

  router.get('/analytics/overview', async (req: AuthedRequest, res: Response) => {
    const scope = await extractAccessScope(req, deps.cfg, {
      defaultUnauthenticatedRole: defaultRole,
    }).catch(() => null);
    if (scope?.role !== 'ADMIN' && scope?.role !== 'SUPER_ADMIN') {
      res.status(403).json({ error: 'Admin access required for analytics' });
      return;
    }
    res.json({ ok: true, analytics: deps.guideService.getAnalytics() });
  });

  router.get('/:guideId', async (req: AuthedRequest, res: Response) => {
    const guideId = String(req.params.guideId);
    const scope = await extractAccessScope(req, deps.cfg, {
      defaultUnauthenticatedRole: defaultRole,
    }).catch(() => null);
    const guide = deps.guideService.getGuideById(guideId, scope);
    if (!guide) {
      res.status(404).json({ error: 'Guide not found or not permitted for your role' });
      return;
    }
    res.json({ ok: true, guide });
  });

  router.post('/progress', async (req: AuthedRequest, res: Response) => {
    const scope = await extractAccessScope(req, deps.cfg, {
      defaultUnauthenticatedRole: defaultRole,
    }).catch(() => null);
    const { guideId, stepId, status } = req.body || {};
    if (!guideId || !stepId || !status) {
      res.status(400).json({ error: 'guideId, stepId, and status are required' });
      return;
    }
    deps.guideService.recordProgress({
      userId: scope?.userId || 'default-user',
      guideId: String(guideId),
      stepId: String(stepId),
      status,
      updatedAt: new Date().toISOString(),
    });
    res.json({ ok: true });
  });

  router.post('/:guideId/progress', async (req: AuthedRequest, res: Response) => {
    const scope = await extractAccessScope(req, deps.cfg, {
      defaultUnauthenticatedRole: defaultRole,
    }).catch(() => null);
    const guideId = String(req.params.guideId);
    const { stepId = 'step', status = 'step_reached' } = req.body || {};
    deps.guideService.recordProgress({
      userId: scope?.userId || 'default-user',
      guideId,
      stepId: String(stepId),
      status,
      updatedAt: new Date().toISOString(),
    });
    res.json({ ok: true });
  });

  router.post('/analytics', async (req: AuthedRequest, res: Response) => {
    const scope = await extractAccessScope(req, deps.cfg, {
      defaultUnauthenticatedRole: defaultRole,
    }).catch(() => null);
    const { guideId = 'unknown', stepId = 'step', event = 'step_reached' } = req.body || {};
    deps.guideService.recordProgress({
      userId: scope?.userId || 'default-user',
      guideId: String(guideId),
      stepId: String(stepId),
      status: event,
      updatedAt: new Date().toISOString(),
    });
    res.json({ ok: true });
  });

  router.post('/tts', (req: AuthedRequest, res: Response) => {
    const { text, guideId, stepId, lang = 'en' } = req.body || {};
    if (!text || typeof text !== 'string') {
      res.status(400).json({ error: 'Text string is required' });
      return;
    }
    const cacheKey = `${guideId || 'adhoc'}:${stepId || 'step'}:${lang}:${text.slice(0, 32)}`;
    let audioBuffer = ttsAudioCache.get(cacheKey);
    if (!audioBuffer) {
      audioBuffer = createFallbackWav(text);
      ttsAudioCache.set(cacheKey, audioBuffer);
    }
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(audioBuffer);
  });

  return router;
}
