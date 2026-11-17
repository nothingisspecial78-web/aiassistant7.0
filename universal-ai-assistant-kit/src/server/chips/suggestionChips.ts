import type { AccessScope } from '../security/scope.ts';
import { getRankedChips, resolvePageId } from './pageRegistry.ts';

export interface SuggestionChipResult {
  id: string;
  label: string;
  prompt: string;
  guideId?: string;
}

export function buildSuggestionChips(params: {
  scope?: AccessScope;
  routePath?: string;
  language?: 'en' | 'ml';
  limit?: number;
}): SuggestionChipResult[] {
  const scope: AccessScope = params.scope || {
    role: 'ADMIN',
    userId: 'default-user',
    organizationId: 'default',
  };
  const pageId = resolvePageId(params.routePath);
  const chips = getRankedChips({
    scope,
    pageId,
    lang: params.language === 'ml' ? 'ml' : 'en',
    limit: params.limit ?? 4,
  });

  return chips.map((c) => ({
    id: c.id,
    label: c.label,
    prompt: c.prompt,
    ...(c.action.type === 'start_guide' && c.action.guideId ? { guideId: c.action.guideId } : {}),
  }));
}
