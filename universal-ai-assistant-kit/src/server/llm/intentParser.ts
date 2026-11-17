import { getRegisteredEntityConfig } from '../entityRegistry/searchEngine.ts';
import { GuideService } from '../guides/guideService.ts';
import type { AccessScope } from '../security/scope.ts';
import { getConversationDataset } from '../tools/datasetState.ts';
import { normalizeExportFormat } from '../tools/exportTools.ts';
import type { ToolDefinition } from '../tools/types.ts';

export interface DeterministicToolCall {
  name: string;
  args: Record<string, unknown>;
}

const DEFAULT_GUIDE_SERVICE = new GuideService();

const GREETING_RE =
  /^(?:hi|hello|hey|hai|good\s+(?:morning|afternoon|evening)|thanks|thank\s+you|ok|okay|ഹലോ|നമസ്കാരം)[!.,?\s]*$/i;

const GUIDE_PHRASE_RE =
  /\b(guide\s+me|walk\s*through|step\s*by\s*step|show\s+me\s+how\s+to|help\s+me\s+(?:with|do|create|add|find|navigate)|how\s+do\s+i|how\s+can\s+i|tutorial|interactive\s+guide|വഴികാട്ടി|സഹായിക്കൂ|എങ്ങനെ)\b/i;

const SEARCH_ENTITY_RE =
  /\b(?:find|search|look\s*up|who\s+is|show\s+me|details\s+(?:of|for|about)|fetch|get)\s+(?:record|item|entry|user|member|entity)?\s*["']?([a-z0-9@._\s-]{2,60})["']?/i;

const EXPORT_INTENT_RE =
  /\b(export|download|generate\s+(?:a|an|the)?\s*(?:pdf|excel|xlsx|csv|word|docx|json|txt)|convert\s+to\s+(?:pdf|excel|csv|word|json)|same\s+as\s+(?:csv|pdf|excel|xlsx|word|docx|json|txt))\b/i;

const LIST_QUERY_RE =
  /\b(list\s+all|show\s+all|all\s+(?:records|items|entries|students|users|orders|invoices|tasks|members|entities)|filter\s+by|sort\s+by|top\s+\d+|pending\s+only|add\s+column|remove\s+column|only\s+show)\b/i;

const UI_NAV_RE =
  /\b(open|go\s+to|switch\s+to|navigate\s+to|show\s+(?:tab|page|view|screen))\s+(?:the\s+)?([a-z0-9_-]+)\b/i;

export function shouldUseAgentLoop(params: {
  question: string;
  tools: Map<string, ToolDefinition>;
  hasAttachments?: boolean;
  hasLiveProvider?: boolean;
}): boolean {
  const q = (params.question || '').trim();
  if (params.tools.size === 0) return false;
  if (!q || GREETING_RE.test(q)) return false;

  if (EXPORT_INTENT_RE.test(q)) return true;
  if (LIST_QUERY_RE.test(q)) return true;
  if (GUIDE_PHRASE_RE.test(q)) return true;
  if (SEARCH_ENTITY_RE.test(q)) return true;
  if (UI_NAV_RE.test(q)) return true;
  if (params.hasLiveProvider && q.length > 4) return true;
  return false;
}

export function extractEntitySearchQuery(question: string): string | null {
  const m = SEARCH_ENTITY_RE.exec(question);
  if (m && m[1]) {
    const cleaned = m[1].trim().replace(/[?.!]+$/, '').trim();
    if (cleaned.length >= 2 && !/^(the|this|that|page|screen|app|help)$/i.test(cleaned)) {
      return cleaned;
    }
  }
  return null;
}

function detectFormatFromText(text: string): string | undefined {
  const m =
    /\b(xlsx?|excel|spreadsheet|pdf|csv|docx?|word|json|txt|numbers|ods|pages|xml|yaml)\b/i.exec(
      text
    );
  if (!m) return undefined;
  return m[1].toLowerCase();
}

export function extractExportToolCall(params: {
  question: string;
  appId: string;
  conversationId?: string;
  scope?: AccessScope;
}): DeterministicToolCall | null {
  const q = params.question.trim();
  if (!EXPORT_INTENT_RE.test(q)) return null;

  const requestedFmt = detectFormatFromText(q);
  const norm = normalizeExportFormat(requestedFmt);
  const prev = getConversationDataset(params.conversationId, params.scope, params.appId);
  const isFollowUpReExport =
    /\b(same\s+as|export\s+(?:that|this|it)|download\s+(?:that|this|it)|convert\s+(?:that|this|it))\b/i.test(
      q
    ) || Boolean(prev && q.split(/\s+/).length <= 5 && requestedFmt);

  const entityCfg = getRegisteredEntityConfig(params.appId);
  let matchedEntityType: string | undefined;
  const qLower = q.toLowerCase();
  for (const ent of entityCfg.entities) {
    if (
      qLower.includes(ent.type.toLowerCase()) ||
      qLower.includes(ent.label.toLowerCase()) ||
      (ent.pluralLabel && qLower.includes(ent.pluralLabel.toLowerCase()))
    ) {
      matchedEntityType = ent.type;
      break;
    }
  }

  return {
    name: 'export_data',
    args: {
      ...(norm.format
        ? { format: norm.format }
        : norm.unsupportedRequested
          ? { format: norm.unsupportedRequested }
          : {}),
      ...(matchedEntityType ? { entityType: matchedEntityType } : {}),
      ...(isFollowUpReExport ? { usePrevious: true } : {}),
      ...( /\bpending\b/i.test(q) ? { pendingOnly: true } : {}),
    },
  };
}

export function parseQueryIntent(
  question: string,
  appId: string,
  conversationId?: string,
  scope?: AccessScope
): DeterministicToolCall | null {
  const q = question.trim();
  if (!LIST_QUERY_RE.test(q)) return null;

  const entityCfg = getRegisteredEntityConfig(appId);
  const qLower = q.toLowerCase();
  let entityType: string | undefined;
  for (const ent of entityCfg.entities) {
    if (
      qLower.includes(ent.type.toLowerCase()) ||
      qLower.includes(ent.label.toLowerCase()) ||
      (ent.pluralLabel && qLower.includes(ent.pluralLabel.toLowerCase()))
    ) {
      entityType = ent.type;
      break;
    }
  }

  const limitMatch = /\btop\s+(\d+)\b/i.exec(q);
  const limit = limitMatch ? Math.max(1, Math.min(500, Number(limitMatch[1]))) : undefined;

  const prev = getConversationDataset(conversationId, scope, appId);
  const refinePrev = Boolean(
    prev && /\b(add\s+column|remove\s+column|only\s+show|sort\s+by|filter)\b/i.test(q)
  );

  return {
    name: 'query_entities',
    args: {
      ...(entityType ? { entityType } : {}),
      ...(limit ? { limit } : {}),
      ...( /\bpending\b/i.test(q) ? { pendingOnly: true } : {}),
      ...(refinePrev ? { usePrevious: true } : {}),
    },
  };
}

export function inferDeterministicToolCall(params: {
  question: string;
  tools: Map<string, ToolDefinition>;
  appId?: string;
  conversationId?: string;
  scope?: AccessScope;
  guideService?: GuideService;
}): DeterministicToolCall | null {
  const q = (params.question || '').trim();
  if (!q || GREETING_RE.test(q)) return null;

  const appId = params.appId || 'default';
  const guideSvc = params.guideService || DEFAULT_GUIDE_SERVICE;

  // 1. Export intent ("export as excel/pdf/csv...", "Same as CSV")
  if (params.tools.has('export_data')) {
    const exportCall = extractExportToolCall({
      question: q,
      appId,
      conversationId: params.conversationId,
      scope: params.scope,
    });
    if (exportCall) return exportCall;
  }

  // 2. Interactive guide lookup/start
  if (GUIDE_PHRASE_RE.test(q)) {
    const matches = guideSvc.searchGuides(q, params.scope, 3);
    if (matches.length > 0 && params.tools.has('start_guide') && matches[0].score >= 3) {
      return {
        name: 'start_guide',
        args: { guideId: matches[0].guideId },
      };
    }
    if (params.tools.has('search_guides')) {
      return {
        name: 'search_guides',
        args: { query: q },
      };
    }
  }

  // 3. Structured query / list / top N / filter / refine previous dataset
  if (params.tools.has('query_entities')) {
    const qCall = parseQueryIntent(q, appId, params.conversationId, params.scope);
    if (qCall) return qCall;
  }

  // 4. Direct UI tab / route navigation
  if (params.tools.has('controlAppUi')) {
    const nav = UI_NAV_RE.exec(q);
    if (nav && nav[2]) {
      const target = nav[2].trim().toLowerCase();
      return {
        name: 'controlAppUi',
        args: target.startsWith('/') ? { route: target } : { tab: target },
      };
    }
  }

  // 5. Entity search ("find ...", "who is ...", "details for ...")
  if (params.tools.has('search_entities')) {
    const searchQuery = extractEntitySearchQuery(q);
    if (searchQuery) {
      return {
        name: 'search_entities',
        args: { query: searchQuery },
      };
    }
  }

  return null;
}
