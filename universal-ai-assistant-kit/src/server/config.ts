export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface ServerConfig {
  port: number;
  host: string;
  openRouterApiKey: string;
  openRouterBaseUrl: string;
  geminiApiKey: string;
  groqApiKey: string;
  cerebrasApiKey: string;
  mistralApiKey: string;
  hfApiKey: string;
  modelFast: string;
  modelStrong: string;
  modelVision: string;
  modelEmbed: string;
  geminiModelFast: string;
  geminiModelStrong: string;
  geminiModelVision: string;
  geminiModelTranscribe: string;
  geminiEmbedModel: string;
  groqModelFast: string;
  groqModelStrong: string;
  groqModelVision: string;
  groqModelTranscribe: string;
  cerebrasModel: string;
  mistralModel: string;
  hfModel: string;
  ragMinSimilarity: number;
  ragChunkSize: number;
  ragChunkOverlap: number;
  maxUploadBytes: number;
  uploadMaxRows: number;
  llmTimeoutMs: number;
  allowedOrigins: string[];
  profilesDir: string;
  authSecret: string;
  confirmationSecret: string;
  defaultAppUrl: string;
  cacheTtlMs: number;
  rateLimitPerMin: number;
  maxConcurrentStreamsPerUser: number;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  authVerifyUrl: string;
  billingMode: 'disabled' | 'credits';
  requireAuth: boolean;
}

export function loadServerConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const rawOrigins = process.env.ALLOWED_ORIGINS || '*';
  const allowedOrigins = rawOrigins
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const authSecret =
    overrides.authSecret ??
    (process.env.AUTH_SECRET || process.env.JWT_SECRET || 'uai-dev-secret-change-in-production');

  const confirmationSecret =
    overrides.confirmationSecret ??
    (process.env.AI_CONFIRMATION_SECRET || authSecret || 'uai-confirmation-secret');

  const billingEnv = (process.env.AI_BILLING_MODE || '').trim().toLowerCase();
  const billingMode: 'disabled' | 'credits' =
    overrides.billingMode ??
    (billingEnv === 'credits' || billingEnv === 'enabled' ? 'credits' : 'disabled');

  return {
    port: overrides.port ?? Number(process.env.PORT || 3000),
    host: overrides.host ?? (process.env.HOST || '0.0.0.0'),
    openRouterApiKey: overrides.openRouterApiKey ?? (process.env.OPENROUTER_API_KEY || ''),
    openRouterBaseUrl:
      overrides.openRouterBaseUrl ??
      (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1'),
    geminiApiKey:
      overrides.geminiApiKey ?? (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || ''),
    groqApiKey: overrides.groqApiKey ?? (process.env.GROQ_API_KEY || ''),
    cerebrasApiKey: overrides.cerebrasApiKey ?? (process.env.CEREBRAS_API_KEY || ''),
    mistralApiKey: overrides.mistralApiKey ?? (process.env.MISTRAL_API_KEY || ''),
    hfApiKey:
      overrides.hfApiKey ??
      (process.env.HF_TOKEN || process.env.HUGGINGFACE_API_KEY || ''),
    modelFast:
      overrides.modelFast ??
      (process.env.MODEL_FAST || 'meta-llama/llama-3.3-70b-instruct:free'),
    modelStrong:
      overrides.modelStrong ??
      (process.env.MODEL_STRONG || 'meta-llama/llama-3.3-70b-instruct:free'),
    modelVision:
      overrides.modelVision ??
      (process.env.MODEL_VISION || 'google/gemini-2.5-flash'),
    modelEmbed:
      overrides.modelEmbed ?? (process.env.MODEL_EMBED || 'openai/text-embedding-3-small'),
    geminiModelFast:
      overrides.geminiModelFast ?? (process.env.GEMINI_MODEL_FAST || 'gemini-2.5-flash'),
    geminiModelStrong:
      overrides.geminiModelStrong ?? (process.env.GEMINI_MODEL_STRONG || 'gemini-2.5-flash'),
    geminiModelVision:
      overrides.geminiModelVision ?? (process.env.GEMINI_MODEL_VISION || 'gemini-2.5-flash'),
    geminiModelTranscribe:
      overrides.geminiModelTranscribe ??
      (process.env.GEMINI_MODEL_TRANSCRIBE || 'gemini-2.5-flash'),
    geminiEmbedModel:
      overrides.geminiEmbedModel ??
      (process.env.GEMINI_EMBED_MODEL || 'gemini-embedding-001'),
    groqModelFast:
      overrides.groqModelFast ?? (process.env.GROQ_MODEL_FAST || 'llama-3.3-70b-versatile'),
    groqModelStrong:
      overrides.groqModelStrong ?? (process.env.GROQ_MODEL_STRONG || 'llama-3.3-70b-versatile'),
    groqModelVision:
      overrides.groqModelVision ??
      (process.env.GROQ_MODEL_VISION || 'meta-llama/llama-4-scout-17b-16e-instruct'),
    groqModelTranscribe:
      overrides.groqModelTranscribe ??
      (process.env.GROQ_MODEL_TRANSCRIBE || 'whisper-large-v3-turbo'),
    cerebrasModel: overrides.cerebrasModel ?? (process.env.CEREBRAS_MODEL || 'llama-3.3-70b'),
    mistralModel:
      overrides.mistralModel ?? (process.env.MISTRAL_MODEL || 'mistral-small-latest'),
    hfModel:
      overrides.hfModel ?? (process.env.HF_MODEL || 'Qwen/Qwen2.5-72B-Instruct'),
    ragMinSimilarity:
      overrides.ragMinSimilarity ?? Number(process.env.RAG_MIN_SIMILARITY || 0.25),
    ragChunkSize: overrides.ragChunkSize ?? Number(process.env.RAG_CHUNK_SIZE || 900),
    ragChunkOverlap: overrides.ragChunkOverlap ?? Number(process.env.RAG_CHUNK_OVERLAP || 150),
    maxUploadBytes:
      overrides.maxUploadBytes ?? Number(process.env.MAX_UPLOAD_BYTES || 10 * 1024 * 1024),
    uploadMaxRows:
      overrides.uploadMaxRows ?? Number(process.env.UPLOAD_MAX_ROWS || 5000),
    llmTimeoutMs:
      overrides.llmTimeoutMs ?? Number(process.env.LLM_TIMEOUT_MS || 20000),
    allowedOrigins: overrides.allowedOrigins ?? allowedOrigins,
    profilesDir: overrides.profilesDir ?? (process.env.AI_PROFILES_DIR || ''),
    authSecret,
    confirmationSecret,
    defaultAppUrl:
      overrides.defaultAppUrl ??
      (process.env.APP_URL || process.env.BASE_URL || 'http://localhost:3000'),
    cacheTtlMs: overrides.cacheTtlMs ?? Number(process.env.CACHE_TTL_MS || 5 * 60 * 1000),
    rateLimitPerMin: overrides.rateLimitPerMin ?? Number(process.env.RATE_LIMIT_PER_MIN || 40),
    maxConcurrentStreamsPerUser:
      overrides.maxConcurrentStreamsPerUser ??
      Number(process.env.MAX_CONCURRENT_STREAMS || 3),
    supabaseUrl: overrides.supabaseUrl ?? (process.env.SUPABASE_URL || ''),
    supabaseServiceRoleKey:
      overrides.supabaseServiceRoleKey ?? (process.env.SUPABASE_SERVICE_ROLE_KEY || ''),
    authVerifyUrl: overrides.authVerifyUrl ?? (process.env.AUTH_VERIFY_URL || ''),
    billingMode,
    requireAuth:
      overrides.requireAuth ??
      String(process.env.AI_REQUIRE_AUTH || '').toLowerCase() === 'true',
  };
}

function sanitizeLogMeta(meta: unknown): string {
  if (meta === undefined || meta === null) return '';
  if (typeof meta === 'string') return meta;
  if (meta instanceof Error) return meta.message;
  try {
    return JSON.stringify(meta, (_k, v) =>
      v instanceof Error ? { message: v.message, name: v.name } : v
    );
  } catch {
    return '';
  }
}

export const logger = {
  debug(meta: unknown, msg?: string) {
    if (process.env.LOG_LEVEL === 'debug') {
      console.debug('[uai]', msg || '', sanitizeLogMeta(meta));
    }
  },
  info(meta: unknown, msg?: string) {
    if (process.env.NODE_ENV !== 'test') {
      console.info('[uai]', msg || '', sanitizeLogMeta(meta));
    }
  },
  warn(meta: unknown, msg?: string) {
    console.warn('[uai]', msg || '', sanitizeLogMeta(meta));
  },
  error(meta: unknown, msg?: string) {
    console.error('[uai]', msg || '', sanitizeLogMeta(meta));
  },
};
