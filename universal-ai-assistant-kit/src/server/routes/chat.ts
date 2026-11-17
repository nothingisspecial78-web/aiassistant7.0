import crypto from 'node:crypto';
import { Router, type Response } from 'express';
import {
  ChatRequestSchema,
  type AssistantSseEvent,
  type DataAdapter,
} from '../../core/index.ts';
import type { AuthedRequest } from '../auth.ts';
import { checkAndConsumeAiCredit, verifyBillingAccessOnly } from '../billing/checkAndConsume.ts';
import type { OrgCreditStore } from '../billing/creditStore.ts';
import { logger, type ServerConfig } from '../config.ts';
import type { AssistantRepository } from '../db/assistantRepository.ts';
import type { GuideService } from '../guides/guideService.ts';
import { runChatAgent } from '../llm/agentLoop.ts';
import type { LlmGateway } from '../llm/client.ts';
import {
  buildOfflinePublicReply,
  buildPublicGuardRefusalMessage,
  classifyPublicAuthQuery,
  isPublicAuthContext,
} from '../llm/publicGuard.ts';
import type { ProfileRegistry } from '../profiles/loader.ts';
import type { Embedder } from '../rag/embedder.ts';
import { retrieveForQuery } from '../rag/retriever.ts';
import type { VectorStore } from '../rag/store.ts';
import type { ActionLogStore } from '../security/confirmation.ts';
import type { ResponseCache } from '../security/limits.ts';
import { detectLanguage, redactPiiForLog } from '../security/sanitize.ts';
import { extractAccessScope } from '../security/scope.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type { HostDataResolver } from '../tools/types.ts';

export interface ServerDeps {
  cfg: ServerConfig;
  profiles: ProfileRegistry;
  embedder: Embedder;
  vectorStore: VectorStore;
  llm: LlmGateway;
  toolRegistry: ToolRegistry;
  actionStore: ActionLogStore;
  cache: ResponseCache;
  repository: AssistantRepository;
  guideService: GuideService;
  creditStore?: OrgCreditStore;
  dataAdapter?: DataAdapter;
  resolveData?: HostDataResolver;
}

export function shouldCompressHttpResponse(
  req: { path?: string; originalUrl?: string },
  res: { getHeader?: (name: string) => unknown }
): boolean {
  const pathStr = String(req.path || req.originalUrl || '');
  if (
    pathStr.endsWith('/chat') ||
    pathStr.includes('/chat?') ||
    pathStr.endsWith('/assistant') ||
    pathStr.includes('/assistant?')
  ) {
    return false;
  }
  const ct = String(
    res.getHeader?.('Content-Type') || res.getHeader?.('content-type') || ''
  ).toLowerCase();
  if (ct.includes('text/event-stream')) {
    return false;
  }
  return true;
}

function writeSseEvent(res: Response, event: AssistantSseEvent): void {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

export function createChatRouter(deps: ServerDeps): Router {
  const router = Router();

  router.post('/', async (req: AuthedRequest, res: Response) => {
    const reqStart = Date.now();
    const requestId = crypto.randomUUID();
    const parsed = ChatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Invalid chat request payload',
        issues: parsed.error.issues.map((i) => i.message),
      });
      return;
    }

    const profile = req.appProfile || deps.profiles.getDefaultProfile();
    const authUser = req.authUser || { userId: 'default-user', rawToken: '' };

    const scope = await extractAccessScope(req, deps.cfg, {
      defaultUnauthenticatedRole: deps.cfg.requireAuth ? 'PUBLIC' : 'ADMIN',
    });

    const billingSnap = deps.creditStore
      ? await verifyBillingAccessOnly({
          creditStore: deps.creditStore,
          scope,
          cfg: deps.cfg,
        })
      : undefined;

    if (deps.creditStore?.isBillingEnabled && scope.role !== 'PUBLIC') {
      const gate = await checkAndConsumeAiCredit({
        creditStore: deps.creditStore,
        scope,
        actionType: parsed.data.attachments?.length ? 'attachment' : 'chat',
        res,
      });
      if (!gate.allowed) return;
    }

    const conversationId = String(
      parsed.data.conversationId || req.headers['x-thread-id'] || 'default'
    );
    await deps.repository.ensureConversation(conversationId, scope);

    const lastUserText =
      [...parsed.data.messages].reverse().find((m) => m.role === 'user')?.content || '';
    const lang: 'en' | 'ml' =
      parsed.data.language === 'ml'
        ? 'ml'
        : parsed.data.language === 'en'
          ? 'en'
          : detectLanguage(lastUserText);

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const abortController = new AbortController();
    let clientClosed = false;
    let terminalEventSent = false;
    res.on('close', () => {
      if (!res.writableEnded) {
        clientClosed = true;
        abortController.abort();
      }
    });

    const emitSse = (ev: AssistantSseEvent) => {
      if (clientClosed || res.writableEnded || res.destroyed) return;
      if (ev.type === 'done' || ev.type === 'error') {
        terminalEventSent = true;
      }
      writeSseEvent(res, ev);
    };

    try {
      await deps.repository.appendMessage(conversationId, scope, 'user', lastUserText);

      const mergedContexts =
        parsed.data.contexts && parsed.data.contexts.length > 0
          ? parsed.data.contexts
          : parsed.data.context
            ? [parsed.data.context]
            : [];

      // Public / unauthenticated route guard (only when explicitly PUBLIC or on login/signup route)
      const routePath =
        mergedContexts[0]?.routePath ||
        (typeof parsed.data.appState?.pathname === 'string'
          ? parsed.data.appState.pathname
          : undefined);

      if (isPublicAuthContext(scope, routePath, parsed.data.appState)) {
        const publicCheck = classifyPublicAuthQuery(lastUserText, {
          hasAttachments: Boolean(parsed.data.attachments?.length),
          hasContext: mergedContexts.length > 0,
          contextText: mergedContexts.map((c) => `${c.nearbyLabel || ''} ${c.text || ''}`).join(' '),
        });
        if (!publicCheck.allowed) {
          const msg = buildPublicGuardRefusalMessage(lang);
          emitSse({ type: 'token', delta: msg });
          emitSse({
            type: 'done',
            refusal: true,
            model: 'public-guard',
            latencyMs: Date.now() - reqStart,
            sources: [],
          });
          return;
        }
        if (!deps.llm.hasLiveProvider && publicCheck.category !== 'blocked') {
          const msg = buildOfflinePublicReply(publicCheck.category, lastUserText, lang);
          emitSse({ type: 'token', delta: msg });
          emitSse({
            type: 'done',
            refusal: false,
            model: 'public-local-helper',
            latencyMs: Date.now() - reqStart,
            sources: [],
          });
          return;
        }
      }

      const retrieval = await retrieveForQuery({
        profile,
        question: lastUserText,
        context: mergedContexts[0],
        contexts: mergedContexts,
        embedder: deps.embedder,
        store: deps.vectorStore,
        minSimilarity: deps.cfg.ragMinSimilarity,
        bypassOutOfScopeGuard:
          Boolean(parsed.data.attachments?.length) ||
          mergedContexts.length > 0 ||
          deps.toolRegistry.getToolsForProfile(profile, scope).size > 0,
        scope,
      });

      if (retrieval.refused) {
        const msg = retrieval.refusalMessage || profile.refusalMessage;
        emitSse({ type: 'token', delta: msg });
        emitSse({
          type: 'done',
          refusal: true,
          model: 'scope-guard',
          latencyMs: Date.now() - reqStart,
          sources: [],
        });
        return;
      }

      const outcome = await runChatAgent({
        profile,
        cfg: deps.cfg,
        llm: deps.llm,
        toolRegistry: deps.toolRegistry,
        actionStore: deps.actionStore,
        guideService: deps.guideService,
        dataAdapter: deps.dataAdapter,
        resolveData: deps.resolveData,
        userId: authUser.userId || scope.userId,
        authToken: authUser.rawToken,
        scope,
        conversationId,
        question: lastUserText,
        messages: parsed.data.messages,
        context: mergedContexts[0],
        contexts: mergedContexts,
        attachments: parsed.data.attachments,
        appState: parsed.data.appState,
        personalization: parsed.data.personalization,
        language: parsed.data.language,
        retrieval,
        billingStatus: billingSnap?.snapshot,
        emit: emitSse,
        signal: abortController.signal,
      });

      if (!terminalEventSent) {
        emitSse({
          type: 'done',
          refusal: outcome.refusal,
          model: outcome.model,
          latencyMs: outcome.latencyMs,
          sources: outcome.citations || [],
          provider: outcome.provider,
        });
      }

      logger.info(
        {
          event: 'uai_chat_completed',
          requestId,
          appId: profile.appId,
          role: scope.role,
          model: outcome.model,
          latencyMs: Date.now() - reqStart,
          questionPreview: redactPiiForLog(lastUserText.slice(0, 80)),
        },
        'Chat completed'
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unexpected chat processing error';
      logger.error({ requestId, appId: profile.appId, err: redactPiiForLog(message) }, 'Chat failed');
      if (!terminalEventSent) {
        emitSse({ type: 'error', message });
      }
    } finally {
      if (!res.writableEnded) {
        res.end();
      }
    }
  });

  return router;
}
