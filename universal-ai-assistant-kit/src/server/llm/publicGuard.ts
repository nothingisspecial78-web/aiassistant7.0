import type { AccessScope } from '../security/scope.ts';

export type PublicQueryCategory = 'auth_help' | 'assistant_features' | 'greeting' | 'blocked';

export interface PublicQueryClassification {
  allowed: boolean;
  category: PublicQueryCategory;
}

const AUTH_ROUTE_REGEX = /^\/(?:login|signin|sign-in|signup|sign-up|register|auth)(?:\/|$)/i;

export function isPublicAuthRoutePath(routePath?: string): boolean {
  if (!routePath) return false;
  return AUTH_ROUTE_REGEX.test(routePath.trim());
}

export function isPublicAuthContext(
  scope?: AccessScope,
  routePath?: string,
  appState?: Record<string, unknown>
): boolean {
  if (scope?.role === 'PUBLIC') return true;
  if (appState?.role === 'public') return true;
  if (!scope && isPublicAuthRoutePath(routePath)) return true;
  if (!scope && typeof appState?.pathname === 'string' && isPublicAuthRoutePath(appState.pathname)) {
    return true;
  }
  return false;
}

const EXPLICIT_BLOCKED_WORKSPACE_REGEX =
  /\b(export\s+(?:data|report|excel|csv|pdf)|download\s+(?:report|statement|pdf|excel|csv)|audit\s+logs?|delete\s+record|import\s+(?:excel|csv|rows)|create\s+record)\b/i;

const GREETING_ONLY_REGEX =
  /^(?:hi|hello|hey|hai|helo|good\s+(?:morning|afternoon|evening)|namaskaram|salam|ഹലോ|നമസ്കാരം)[!.,?\s]*$/i;

const AUTH_HELP_REGEX =
  /\b(log\s*in|login|sign\s*in|signin|sign\s*up|signup|register|registration|forgot\s*password|reset\s*password|recover\s*password|demo\s*(?:mode|account)?|how\s+to\s+(?:sign\s*in|log\s*in|sign\s*up|register)|ലോഗിൻ|സൈൻ\s*ഇൻ|സൈൻ\s*അപ്പ്|രജിസ്റ്റർ|പാസ്‌വേഡ്)\b/i;

const ASSISTANT_FEATURES_REGEX =
  /\b(ai\s*assistant|this\s*assistant|assistant\s+features?|what\s+(?:can|does)\s+(?:you|this\s+(?:ai|assistant))\s+(?:do|help)|features?|capabilities|guide\s*me|3d\s+(?:avatar|guide)|voice|malayalam|അസിസ്റ്റന്റ്|ഫീച്ചറുകൾ)\b/i;

export function classifyPublicAuthQuery(
  question: string,
  opts?: {
    hasAttachments?: boolean;
    hasContext?: boolean;
    contextText?: string;
  }
): PublicQueryClassification {
  const trimmed = (question || '').trim();
  if (opts?.hasAttachments) return { allowed: false, category: 'blocked' };
  if (!trimmed || GREETING_ONLY_REGEX.test(trimmed)) {
    return { allowed: true, category: 'greeting' };
  }
  if (EXPLICIT_BLOCKED_WORKSPACE_REGEX.test(trimmed)) {
    return { allowed: false, category: 'blocked' };
  }
  if (ASSISTANT_FEATURES_REGEX.test(trimmed)) {
    return { allowed: true, category: 'assistant_features' };
  }
  if (AUTH_HELP_REGEX.test(trimmed)) {
    return { allowed: true, category: 'auth_help' };
  }
  if (
    opts?.hasContext &&
    opts.contextText &&
    /\b(sign\s*in|log\s*in|register|password|email|demo)\b/i.test(opts.contextText)
  ) {
    return { allowed: true, category: 'auth_help' };
  }
  return { allowed: false, category: 'blocked' };
}

export function isPublicGuideGoalAllowed(goal: string, userReply?: string): boolean {
  const combined = `${goal || ''} ${userReply || ''}`.trim();
  if (!combined) return true;
  if (EXPLICIT_BLOCKED_WORKSPACE_REGEX.test(combined)) return false;
  return AUTH_HELP_REGEX.test(combined) || ASSISTANT_FEATURES_REGEX.test(combined);
}

export function buildPublicGuardRefusalMessage(lang: 'en' | 'ml'): string {
  if (lang === 'ml') {
    return 'സൈൻ-ഇൻ / രജിസ്റ്റർ പേജിൽ ലോഗിൻ സഹായവും AI Assistant ഫീച്ചറുകളെക്കുറിച്ചുള്ള ചോദ്യങ്ങളുമാണ് ലഭ്യമാകുക. മറ്റ് ഡാറ്റ പരിശോധിക്കാൻ ദയവായി സൈൻ ഇൻ ചെയ്യുക.';
  }
  return 'On the sign-in screen, I can help with signing in, creating an account, password recovery, or explaining AI Assistant features. Please sign in to access workspace data and exports.';
}

export function buildOfflinePublicReply(
  category: Exclude<PublicQueryCategory, 'blocked'>,
  question: string,
  lang: 'en' | 'ml'
): string {
  if (category === 'greeting') {
    return lang === 'ml'
      ? 'ഹലോ! ലോഗിൻ ചെയ്യാനോ, പുതിയ അക്കൗണ്ട് തുടങ്ങാനോ, AI Assistant ഫീച്ചറുകൾ അറിയാനോ എന്നോട് ചോദിക്കാം.'
      : 'Hi! I can help you sign in, create an account, recover your password, or explore AI Assistant features.';
  }

  if (category === 'assistant_features') {
    return lang === 'ml'
      ? '**AI Assistant ഫീച്ചറുകൾ:**\n- ഇംഗ്ലീഷിലും മലയാളത്തിലും ചോദ്യോത്തരങ്ങൾ\n- 3D ഇന്ററാക്ടീവ് ഗൈഡ് ("Guide me")\n- Excel (.xlsx), PDF, CSV, Word (.docx) എക്സ്പോർട്ടുകൾ\n- സ്ക്രീൻഷോട്ട്, ഫയൽ & വോയ്സ് ഇൻപുട്ട്'
      : '**AI Assistant Capabilities:**\n- Natural language search across workspace records (English & Malayalam)\n- Interactive 3D Co-Browser Guide ("Guide me step by step")\n- Multi-format exports: Excel (.xlsx), PDF, CSV, Word (.docx), JSON, TXT\n- Multimodal file/screenshot analysis, voice input, and cursor element inspection';
  }

  const q = question.toLowerCase();
  if (/password|forgot|reset/i.test(q)) {
    return lang === 'ml'
      ? 'പാസ്‌വേഡ് റീസെറ്റ് ചെയ്യാൻ ലോഗിൻ ഫോമിലെ Forgot Password ഓപ്ഷൻ ഉപയോഗിക്കുക.'
      : 'Use the Forgot Password link on the Sign-In form or contact your workspace administrator to reset your credentials.';
  }
  return lang === 'ml'
    ? 'ലോഗിൻ ചെയ്യുന്നതിന് നിങ്ങളുടെ ഇമെയിലും പാസ്‌വേഡും നൽകുക അല്ലെങ്കിൽ പുതിയ അക്കൗണ്ടിനായി Sign Up തിരഞ്ഞെടുക്കുക.'
    : 'Enter your email and password on the Sign In tab, or switch to Sign Up / Register to create a new account.';
}
