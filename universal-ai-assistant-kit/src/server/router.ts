import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import {
  defaultAssistantConfig,
  type AppProfile,
  type AssistantConfig,
  type AssistantEntityConfig,
  type DataAdapter,
  type GuideDef,
  type SheetTemplate,
} from '../core/index.ts';
import { createAuthMiddleware, dispatchInProcess, type ResolveUserFn } from './auth.ts';
import { OrgCreditStore } from './billing/creditStore.ts';
import { RazorpayPaymentProvider } from './billing/paymentProvider.ts';
import type { BillingConfig } from './billing/types.ts';
import { registerEntityConfigChips } from './chips/pageRegistry.ts';
import { loadServerConfig, type ServerConfig } from './config.ts';
import { AssistantRepository } from './db/assistantRepository.ts';
import { registerEntityConfig } from './entityRegistry/searchEngine.ts';
import { GuideService } from './guides/guideService.ts';
import { createLlmGateway, type LlmGateway } from './llm/client.ts';
import { ProfileRegistry, type LoadedDoc } from './profiles/loader.ts';
import { Embedder } from './rag/embedder.ts';
import { ingestAllProfiles } from './rag/retriever.ts';
import { VectorStore } from './rag/store.ts';
import { createActionsRouter } from './routes/actions.ts';
import { createBillingRouter } from './routes/billing.ts';
import { createChatRouter } from './routes/chat.ts';
import { createChipsRouter } from './routes/chips.ts';
import { createGuidesRouter } from './routes/guides.ts';
import { createGuideStepRouter } from './routes/guideStep.ts';
import { createIngestRouter } from './routes/ingest.ts';
import { createPaymentsRouter, createPaymentWebhookHandler } from './routes/payments.ts';
import { createTranscribeRouter } from './routes/transcribe.ts';
import { createUploadRouter } from './routes/upload.ts';
import { ActionLogStore } from './security/confirmation.ts';
import { createChatRateLimiter, ResponseCache } from './security/limits.ts';
import { ToolRegistry } from './tools/registry.ts';
import type { HostDataResolver, ToolDefinition } from './tools/types.ts';

export interface UniversalAssistantRouterOptions {
  config?: Partial<ServerConfig> & Partial<AssistantConfig>;
  entityConfig?: AssistantEntityConfig;
  entityConfigs?: AssistantEntityConfig[];
  profile?: AppProfile;
  profiles?: Array<{
    profile: AppProfile;
    docs?: LoadedDoc[];
    templates?: SheetTemplate[];
  }>;
  profilesDir?: string;
  customTools?: ToolDefinition[];
  customGuides?: GuideDef[];
  dataAdapter?: DataAdapter;
  resolveData?: HostDataResolver;
  resolveUser?: ResolveUserFn;
  billing?: Partial<BillingConfig>;
  requireAuth?: boolean;
  rateLimitPerMin?: number;
  enableCors?: boolean;
}

export interface AssistantRuntime {
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
  creditStore: OrgCreditStore;
  razorpayProvider: RazorpayPaymentProvider;
  ready: Promise<void>;
}

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const CANDIDATE_FONT_DIRS = [
  path.resolve(THIS_DIR, '../../assets/fonts'),
  path.resolve(THIS_DIR, '../assets/fonts'),
];

async function resolveFontFile(filename: string): Promise<string | null> {
  const safeName = path.basename(filename);
  if (!safeName.endsWith('.ttf') && !safeName.endsWith('.otf') && !safeName.endsWith('.woff2')) {
    return null;
  }
  for (const dir of CANDIDATE_FONT_DIRS) {
    const candidate = path.join(dir, safeName);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // try next dir
    }
  }
  return null;
}

export function createAssistantRuntime(
  options: UniversalAssistantRouterOptions = {}
): AssistantRuntime {
  const cfg = loadServerConfig({
    ...(options.config || {}),
    ...(options.profilesDir !== undefined ? { profilesDir: options.profilesDir } : {}),
    ...(options.requireAuth !== undefined ? { requireAuth: options.requireAuth } : {}),
    ...(options.billing?.mode ? { billingMode: options.billing.mode } : {}),
    ...(options.rateLimitPerMin !== undefined
      ? { rateLimitPerMin: options.rateLimitPerMin }
      : {}),
  });

  const profiles = new ProfileRegistry();
  if (options.profile) {
    profiles.registerProfile(options.profile);
  }
  for (const entry of options.profiles || []) {
    profiles.registerProfile(entry.profile, entry.docs || [], entry.templates || []);
  }

  // Register generic fallback entity config first, then host overrides
  registerEntityConfig(defaultAssistantConfig);
  if (options.entityConfig) {
    registerEntityConfig(options.entityConfig);
    registerEntityConfigChips(options.entityConfig);
  }
  for (const ec of options.entityConfigs || []) {
    registerEntityConfig(ec);
    registerEntityConfigChips(ec);
  }

  const embedder = new Embedder(cfg);
  const vectorStore = new VectorStore(cfg);
  const llm = createLlmGateway(cfg);
  const toolRegistry = new ToolRegistry(options.customTools || []);
  const actionStore = new ActionLogStore();
  const cache = new ResponseCache(cfg.cacheTtlMs);
  const repository = new AssistantRepository(cfg);
  const guideService = new GuideService(options.customGuides || []);
  const creditStore = new OrgCreditStore(cfg, {
    billingConfig: {
      mode: cfg.billingMode,
      ...(options.billing || {}),
    },
  });
  const razorpayProvider = new RazorpayPaymentProvider();

  const ready = (async () => {
    if (cfg.profilesDir) {
      await profiles.loadAll(cfg.profilesDir);
    }
    await ingestAllProfiles({
      profiles,
      embedder,
      store: vectorStore,
    });
  })();

  return {
    cfg,
    profiles,
    embedder,
    vectorStore,
    llm,
    toolRegistry,
    actionStore,
    cache,
    repository,
    guideService,
    creditStore,
    razorpayProvider,
    ready,
  };
}

export type UniversalAssistantExpressRouter = Router & {
  runtime: AssistantRuntime;
};

export function createUniversalAssistantRouter(
  options: UniversalAssistantRouterOptions = {}
): UniversalAssistantExpressRouter {
  const runtime = createAssistantRuntime(options);
  const router = Router() as UniversalAssistantExpressRouter;
  router.runtime = runtime;

  if (options.enableCors !== false) {
    router.use((req: Request, res: Response, next: NextFunction) => {
      const origin = req.headers.origin;
      const allowAll = runtime.cfg.allowedOrigins.includes('*');
      if (origin && (allowAll || runtime.cfg.allowedOrigins.includes(origin))) {
        res.setHeader('Access-Control-Allow-Origin', origin);
      } else if (allowAll) {
        res.setHeader('Access-Control-Allow-Origin', '*');
      }
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type,Authorization,x-app-id,x-user-id,x-org-id,x-organization-id,x-thread-id,X-Idempotency-Key'
      );
      if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
      }
      next();
    });
  }

  // Ensure initial docs ingestion finished before handling requests
  router.use((_req: Request, _res: Response, next: NextFunction) => {
    runtime.ready.then(() => next()).catch(next);
  });

  // Raw webhook before JSON body parser so HMAC signatures verify exact bytes
  const webhookHandler = createPaymentWebhookHandler({
    cfg: runtime.cfg,
    creditStore: runtime.creditStore,
    razorpayProvider: runtime.razorpayProvider,
  });
  router.post(
    '/payments/webhook',
    express.raw({ type: 'application/json', limit: '2mb' }),
    webhookHandler
  );
  router.post(
    '/assistant/payments/webhook',
    express.raw({ type: 'application/json', limit: '2mb' }),
    webhookHandler
  );

  router.use(createChatRateLimiter(runtime.cfg));
  router.use(express.json({ limit: '10mb' }));
  router.use(express.urlencoded({ extended: true, limit: '10mb' }));

  router.get('/health', (_req: Request, res: Response) => {
    const providerHealth = runtime.llm.chain.getDebugStatuses();
    res.json({
      status: 'ok',
      ok: true,
      hasLiveProvider: runtime.llm.hasLiveProvider,
      billingMode: runtime.creditStore.billingConfig.mode,
      profiles: runtime.profiles.listProfiles().map((p) => p.appId),
      providers: providerHealth,
      timestamp: new Date().toISOString(),
    });
  });

  router.get('/self-check', (_req: Request, res: Response) => {
    const providers = runtime.llm.chain.getDebugStatuses();
    const configured = providers.filter((p) => p.configured).map((p) => p.name);
    res.json({
      ok: true,
      ready: true,
      liveAiConfigured: configured.length > 0,
      configuredProviders: configured,
      fallbackMode: configured.length > 0 ? 'live-with-local-fallback' : 'local-deterministic',
      profilesLoaded: runtime.profiles.listProfiles().length,
      guidesLoaded: runtime.guideService.getAllGuides().length,
      billingEnabled: runtime.creditStore.isBillingEnabled,
      dataAdapterConfigured: Boolean(options.dataAdapter || options.resolveData),
    });
  });

  router.get('/profiles', (_req: Request, res: Response) => {
    res.json({
      profiles: runtime.profiles.listProfiles().map((p) => ({
        appId: p.appId,
        displayName: p.displayName,
        languages: p.languages,
        tools: p.tools,
      })),
    });
  });

  router.get('/debug/providers', (_req: Request, res: Response) => {
    res.json({
      providers: runtime.llm.chain.getDebugStatuses(),
      hasLiveProvider: runtime.llm.hasLiveProvider,
    });
  });

  const serveFont = async (req: Request, res: Response) => {
    const filePath = await resolveFontFile(String(req.params.file || ''));
    if (!filePath) {
      res.status(404).json({ error: 'Font not found.' });
      return;
    }
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(filePath);
  };
  router.get('/fonts/:file', serveFont);
  router.get('/exports/fonts/:file', serveFont);

  router.post('/sync/ack', (_req: Request, res: Response) => {
    res.json({ ok: true, syncedAt: new Date().toISOString() });
  });

  const authMw = createAuthMiddleware(runtime.profiles, runtime.cfg, options.resolveUser);

  const chatRouter = createChatRouter({
    cfg: runtime.cfg,
    profiles: runtime.profiles,
    embedder: runtime.embedder,
    vectorStore: runtime.vectorStore,
    llm: runtime.llm,
    toolRegistry: runtime.toolRegistry,
    actionStore: runtime.actionStore,
    cache: runtime.cache,
    repository: runtime.repository,
    guideService: runtime.guideService,
    creditStore: runtime.creditStore,
    dataAdapter: options.dataAdapter,
    resolveData: options.resolveData,
  });

  const uploadRouter = createUploadRouter({
    cfg: runtime.cfg,
    profiles: runtime.profiles,
    actionStore: runtime.actionStore,
    creditStore: runtime.creditStore,
  });

  const transcribeRouter = createTranscribeRouter({
    cfg: runtime.cfg,
    creditStore: runtime.creditStore,
  });

  const guideStepRouter = createGuideStepRouter({
    cfg: runtime.cfg,
    creditStore: runtime.creditStore,
  });

  const guidesRouter = createGuidesRouter({
    cfg: runtime.cfg,
    guideService: runtime.guideService,
  });

  const chipsRouter = createChipsRouter({
    cfg: runtime.cfg,
    repository: runtime.repository,
  });

  const actionsRouter = createActionsRouter({
    cfg: runtime.cfg,
    toolRegistry: runtime.toolRegistry,
    actionStore: runtime.actionStore,
    guideService: runtime.guideService,
    dataAdapter: options.dataAdapter,
    resolveData: options.resolveData,
  });

  const billingRouter = createBillingRouter({
    cfg: runtime.cfg,
    creditStore: runtime.creditStore,
  });

  const paymentsRouter = createPaymentsRouter({
    cfg: runtime.cfg,
    creditStore: runtime.creditStore,
    razorpayProvider: runtime.razorpayProvider,
  });

  const ingestRouter = createIngestRouter({
    profiles: runtime.profiles,
    embedder: runtime.embedder,
    vectorStore: runtime.vectorStore,
    cache: runtime.cache,
  });

  router.use('/chat', authMw, chatRouter);
  router.use('/assistant/chat', authMw, chatRouter);
  router.post('/assistant', authMw, (req, res, next) => {
    req.url = '/';
    chatRouter(req, res, next);
  });

  router.use('/upload', authMw, uploadRouter);
  router.use('/assistant/upload', authMw, uploadRouter);

  router.use('/transcribe', authMw, transcribeRouter);
  router.use('/assistant/transcribe', authMw, transcribeRouter);

  router.use('/guide-step', authMw, guideStepRouter);
  router.use('/assistant/guide-step', authMw, guideStepRouter);

  router.use('/guides', authMw, guidesRouter);
  router.use('/assistant/guides', authMw, guidesRouter);

  router.use('/actions', authMw, actionsRouter);
  router.use('/assistant/actions', authMw, actionsRouter);

  router.use('/billing', authMw, billingRouter);
  router.use('/assistant/billing', authMw, billingRouter);

  router.use('/payments', authMw, paymentsRouter);
  router.use('/assistant/payments', authMw, paymentsRouter);

  router.use('/ingest', authMw, ingestRouter);
  router.use('/assistant/ingest', authMw, ingestRouter);

  router.use('/chips', authMw, chipsRouter);
  router.use('/assistant', authMw, chipsRouter);

  return router;
}

export function createUniversalAssistantNextHandler(
  options: UniversalAssistantRouterOptions & { basePath?: string } = {}
) {
  const router = createUniversalAssistantRouter(options);
  const basePath = (options.basePath || '/api/uai').replace(/\/$/, '');

  return async function universalAssistantNextHandler(req: Request | globalThis.Request, res?: Response) {
    // Pages Router: handler(req, res)
    if (res && typeof (res as unknown as Record<string, unknown>).status === 'function') {
      const nodeReq = req as Request;
      if (basePath && nodeReq.url.startsWith(basePath)) {
        nodeReq.url = nodeReq.url.slice(basePath.length) || '/';
      }
      return new Promise<void>((resolve) => {
        router(nodeReq, res, () => {
          if (!res.headersSent) {
            res.status(404).json({ error: 'Assistant route not found.' });
          }
          resolve();
        });
      });
    }

    // App Router: handler(request: globalThis.Request) -> globalThis.Response
    const webReq = req as globalThis.Request;
    const url = new URL(webReq.url);
    const trimmedPath =
      basePath && url.pathname.startsWith(basePath)
        ? url.pathname.slice(basePath.length) || '/'
        : url.pathname;
    const forwardedUrl = `http://localhost${trimmedPath}${url.search}`;
    const bodyBuf =
      webReq.method !== 'GET' && webReq.method !== 'HEAD'
        ? Buffer.from(await webReq.arrayBuffer())
        : undefined;

    return dispatchInProcess(
      (nodeReq, nodeRes) => {
        router(nodeReq as unknown as Request, nodeRes as unknown as Response, () => {
          nodeRes.statusCode = 404;
          nodeRes.setHeader('Content-Type', 'application/json');
          nodeRes.end(JSON.stringify({ error: 'Assistant route not found.' }));
        });
      },
      forwardedUrl,
      {
        method: webReq.method,
        headers: webReq.headers,
        body: bodyBuf,
      }
    );
  };
}
