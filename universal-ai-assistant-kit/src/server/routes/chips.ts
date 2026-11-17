import express, { type Request, type Response } from 'express';
import { getRankedChips, resolvePageId } from '../chips/pageRegistry.ts';
import type { ServerConfig } from '../config.ts';
import type { AssistantRepository } from '../db/assistantRepository.ts';
import { extractAccessScope } from '../security/scope.ts';
import {
  clearUserAbandonedForm,
  recordUserAbandonedForm,
} from '../tools/datasetState.ts';

export function createChipsRouter(params: {
  cfg: ServerConfig;
  repository: AssistantRepository;
}): express.Router {
  const router = express.Router();
  const { cfg, repository } = params;
  const defaultRole = cfg.requireAuth ? 'PUBLIC' : 'ADMIN';

  const handleGetChips = async (req: Request, res: Response) => {
    const start = Date.now();
    try {
      const scope = await extractAccessScope(req, cfg, {
        defaultUnauthenticatedRole: defaultRole,
      });
      const rawPage = String(req.query.pathname || req.query.pageId || 'global');
      const pageId = resolvePageId(
        typeof req.query.pageId === 'string' && req.query.pageId ? req.query.pageId : rawPage
      );
      const lang = (String(req.query.lang || 'en').toLowerCase() === 'ml' ? 'ml' : 'en') as
        | 'en'
        | 'ml';

      const chips = getRankedChips({
        scope,
        pageId,
        lang,
        limit: Number(req.query.limit || 4),
      });

      for (const chip of chips) {
        void repository.recordChipImpression(scope.userId, chip.id);
      }

      const latencyMs = Date.now() - start;
      res.setHeader('X-Response-Time', `${latencyMs}ms`);
      res.json({
        ok: true,
        pageId,
        pageTitle: pageId === 'home' ? 'Workspace' : pageId,
        role: scope.role,
        chips,
        latencyMs,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: message });
    }
  };

  const handleChipClick = async (req: Request, res: Response) => {
    try {
      const scope = await extractAccessScope(req, cfg, {
        defaultUnauthenticatedRole: defaultRole,
      });
      const chipId = String(req.body?.chipId || '').trim();
      if (!chipId) {
        res.status(400).json({ ok: false, error: 'chipId is required' });
        return;
      }
      await repository.recordChipClick(scope.userId, chipId);
      res.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: message });
    }
  };

  const handleAbandoned = async (req: Request, res: Response) => {
    try {
      const scope = await extractAccessScope(req, cfg, {
        defaultUnauthenticatedRole: defaultRole,
      });
      const appId = String(req.body?.appId || req.headers['x-app-id'] || 'default').trim();
      const formType = String(req.body?.formType || 'FORM').trim();
      const title = String(req.body?.title || formType).trim();
      const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : undefined;
      const submitted = Boolean(req.body?.submitted);

      if (submitted) {
        clearUserAbandonedForm({ appId, scope, userId: scope.userId });
      } else {
        recordUserAbandonedForm({
          appId,
          scope,
          userId: scope.userId,
          formType,
          title,
          prompt,
        });
      }
      res.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: message });
    }
  };

  router.get('/', handleGetChips);
  router.get('/chips', handleGetChips);
  router.post('/click', handleChipClick);
  router.post('/chips/click', handleChipClick);
  router.post('/activity/abandoned', handleAbandoned);

  return router;
}
