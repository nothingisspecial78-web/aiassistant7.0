import type { AssistantEntityConfig } from '../../core/index.ts';
import type { NumericFilter, QuerySortSpec, StoredDatasetEntry } from '../tools/datasetState.ts';

export interface ParsedStructuredQueryIntent {
  entityType?: string;
  filters?: Record<string, string | number | boolean>;
  numericFilters?: NumericFilter[];
  pendingOnly?: boolean;
  sort?: QuerySortSpec;
  limit?: number;
  columns?: string[];
  title?: string;
  assumption?: string;
  isFollowUp?: boolean;
}

const KNOWN_COLUMN_PHRASES: Array<{ re: RegExp; key: string }> = [
  { re: /\b(?:ad(?:mission)?\s*no\.?|student\s*id|staff\s*id|employee\s*id|\bid\b)\b/i, key: 'id' },
  { re: /\b(?:full\s*name|student\s*name|name)\b/i, key: 'name' },
  { re: /\btitle\b/i, key: 'title' },
  { re: /\b(?:class(?:\s*name)?|grade|category)\b/i, key: 'category' },
  { re: /\b(?:phone(?:\s*number)?|mobile|contact|telephone)\b/i, key: 'phone' },
  { re: /\b(?:e-?mail(?:\s*address)?)\b/i, key: 'email' },
  { re: /\b(?:pending\s*(?:fee|fees|amount)?|dues?|due|owed|unpaid)\b/i, key: 'pendingFee' },
  { re: /\b(?:net\s*balance|net\s*worth|balance|net)\b/i, key: 'balance' },
  { re: /\b(?:credit|credits|total\s*paid|paid)\b/i, key: 'paidTotal' },
  { re: /\b(?:debit|debits|total\s*billed|billed)\b/i, key: 'debitTotal' },
  { re: /\b(?:amount|price|total|value)\b/i, key: 'amount' },
  { re: /\bstatus\b/i, key: 'status' },
  { re: /\b(?:date|created\s*at|updated\s*at)\b/i, key: 'createdAt' },
];

export function extractColumnsFromText(text: string): string[] {
  const found: string[] = [];
  for (const item of KNOWN_COLUMN_PHRASES) {
    if (item.re.test(text) && !found.includes(item.key)) {
      found.push(item.key);
    }
  }
  return found;
}

function detectEntityTypeFromConfig(
  lower: string,
  config?: AssistantEntityConfig,
  fallback?: string
): string | undefined {
  if (config) {
    for (const ent of config.entities) {
      const singular = ent.label.toLowerCase();
      const plural = (ent.pluralLabel || `${ent.label}s`).toLowerCase();
      if (lower.includes(plural) || lower.includes(singular) || lower.includes(ent.type.toLowerCase())) {
        return ent.type;
      }
    }
  }
  return fallback || config?.entities[0]?.type;
}

function extractSortSpec(lower: string): QuerySortSpec | undefined {
  if (/\b(highest\s+(?:due|pending|dues|amount|balance)|most\s+(?:due|pending)|sort\s+by\s+highest)\b/i.test(lower)) {
    return { field: /\bbalance\b/i.test(lower) ? 'balance' : /\bamount\b/i.test(lower) ? 'amount' : 'pendingFee', dir: 'desc' };
  }
  if (/\b(lowest\s+(?:due|pending|amount|balance)|smallest\s+due|sort\s+by\s+lowest)\b/i.test(lower)) {
    return { field: /\bbalance\b/i.test(lower) ? 'balance' : /\bamount\b/i.test(lower) ? 'amount' : 'pendingFee', dir: 'asc' };
  }
  if (/\b(sort\s+by\s+name|alphabetical)\b/i.test(lower)) {
    return { field: 'name', dir: 'asc' };
  }
  return undefined;
}

function extractLimitSpec(lower: string): number | undefined {
  const m = /\b(?:top|first|limit(?:\s+to)?)\s+(\d{1,4})\b/i.exec(lower);
  if (m?.[1]) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 5000) return n;
  }
  return undefined;
}

function extractNumericFilters(lower: string): {
  numericFilters: NumericFilter[];
  isNegativeBalance: boolean;
} {
  const numericFilters: NumericFilter[] = [];
  let isNegativeBalance = false;

  if (/\b(negative\s+(?:balance|worth)|minus\s+balance|below\s+zero|less\s+than\s+zero|<\s*0)\b/i.test(lower)) {
    numericFilters.push({ field: 'balance', op: '<', value: 0 });
    isNegativeBalance = true;
  }

  const symbolPattern =
    /\b(balance|amount|price|total|due|dues|pending(?:\s*fee)?|credit|paid|debit)\s*(<=|>=|!=|<|>|=)\s*(-?\d[\d,]*)/gi;
  for (const match of lower.matchAll(symbolPattern)) {
    const rawField = match[1].toLowerCase();
    const op = match[2] as NumericFilter['op'];
    const value = Number(match[3].replace(/,/g, ''));
    const field = rawField.includes('balance')
      ? 'balance'
      : rawField.includes('amount') || rawField.includes('price') || rawField.includes('total')
        ? 'amount'
        : rawField.includes('credit') || rawField.includes('paid')
          ? 'paidTotal'
          : rawField.includes('debit')
            ? 'debitTotal'
            : 'pendingFee';
    if (!numericFilters.some((f) => f.field === field && f.op === op && f.value === value)) {
      numericFilters.push({ field, op, value });
    }
  }

  return { numericFilters, isNegativeBalance };
}

export function isQueryFollowUpRefinement(
  question: string,
  previous?: StoredDatasetEntry
): boolean {
  if (!previous || previous.rows.length === 0) return false;
  const lower = question.trim().toLowerCase();
  if (/\b(download|export|save\s+as|same\s+as|excel|xlsx|pdf|csv|word|docx|json|txt)\b/i.test(lower)) {
    return false;
  }
  return (
    /^(?:add|include|also\s+show|with|show|remove|hide|drop|omit)\s+/i.test(lower) ||
    /^(?:only|just|filter\s+(?:by|to))\s+/i.test(lower) ||
    /^(?:sort\s+by|order\s+by|highest\s+first|lowest\s+first|top\s+\d+|first\s+\d+)\b/i.test(lower)
  );
}

export function parseStructuredQueryIntent(
  question: string,
  previous?: StoredDatasetEntry,
  config?: AssistantEntityConfig
): ParsedStructuredQueryIntent | null {
  const q = question.trim();
  if (!q) return null;
  const lower = q.toLowerCase();

  if (/\b(how\s+(?:do|can|to)\s+i|how\s+to|guide\s+me|walkthrough|show\s+me\s+how|template|import|upload)\b/i.test(lower)) {
    return null;
  }

  if (isQueryFollowUpRefinement(q, previous) && previous) {
    const baseCols = previous.columns.map((c) => c.key);
    const nextCols = [...baseCols];
    const filters = { ...(previous.filters || {}) };
    const numericFilters = [...(previous.numericFilters || [])];
    const pendingOnly = Boolean(previous.pendingOnly);
    let sort = previous.sort ? { ...previous.sort } : undefined;
    let limit = previous.limit;

    if (/^(?:remove|hide|drop|omit)\b/i.test(lower)) {
      for (const k of extractColumnsFromText(q)) {
        const idx = nextCols.indexOf(k);
        if (idx >= 0 && nextCols.length > 1) nextCols.splice(idx, 1);
      }
    } else if (/^(?:add|include|also\s+show|with|show)\b/i.test(lower)) {
      for (const k of extractColumnsFromText(q)) {
        if (!nextCols.includes(k)) nextCols.push(k);
      }
    }

    const newSort = extractSortSpec(lower);
    if (newSort) sort = newSort;
    const newLimit = extractLimitSpec(lower);
    if (newLimit) limit = newLimit;

    return {
      entityType: previous.entityType,
      filters,
      numericFilters,
      pendingOnly,
      sort,
      limit,
      columns: nextCols,
      title: previous.title,
      isFollowUp: true,
    };
  }

  const hasExplicitExport = /\b(export|download|generate\s+(?:an?\s+)?(?:excel|pdf|csv|word|docx|json)|save\s+as|same\s+as|\bexcel\b|\bxlsx\b|\bpdf\b|\bcsv\b|\bdocx\b|\bword\b)\b/i.test(lower);
  if (hasExplicitExport) return null;

  const { numericFilters, isNegativeBalance } = extractNumericFilters(lower);
  const sort = extractSortSpec(lower);
  const limit = extractLimitSpec(lower);

  const isFilteredListQuery =
    numericFilters.length > 0 ||
    Boolean(sort) ||
    Boolean(limit) ||
    /\b(?:only\s+(?:columns?|fields?)|with\s+only\s+)\b/i.test(lower);

  if (!isFilteredListQuery) return null;

  const entityType = detectEntityTypeFromConfig(lower, config);
  const explicitCols = extractColumnsFromText(q);
  const statusMatch = /\b(active|inactive|pending|unpaid|paid|approved|rejected|available)\b/i.exec(lower);
  const filters: Record<string, string | number | boolean> = {};
  if (statusMatch) filters.status = statusMatch[1].trim();

  return {
    entityType,
    filters,
    numericFilters,
    pendingOnly: isNegativeBalance || /\b(pending|unpaid)\b/i.test(lower),
    sort,
    limit,
    columns: explicitCols.length > 0 ? explicitCols : undefined,
    title: 'Filtered Records',
  };
}
