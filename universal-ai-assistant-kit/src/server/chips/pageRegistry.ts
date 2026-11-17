import type { AssistantEntityConfig } from '../../core/index.ts';
import type { AccessScope, ScopeRole } from '../security/scope.ts';

export type SuggestionChipAction =
  | { type: 'send_prompt'; prompt: string }
  | { type: 'prefill_prompt'; prompt: string }
  | { type: 'start_guide'; guideId: string; prompt?: string }
  | { type: 'navigate'; route: string; prompt?: string };

export interface SuggestionChip {
  id: string;
  label: string;
  prompt: string;
  action: SuggestionChipAction;
  priority: number;
  icon?: string;
}

export type PageChipId = string;

interface RegisteredChipTemplate {
  id: string;
  pageIds: Array<'global' | string>;
  roles: Array<ScopeRole>;
  labelEn: string;
  labelMl?: string;
  promptEn: string;
  promptMl?: string;
  action: SuggestionChipAction;
  priority: number;
  icon?: string;
}

export const CHIP_REGISTRY: RegisteredChipTemplate[] = [
  {
    id: 'global.search-records',
    pageIds: ['global', 'home'],
    roles: ['ADMIN', 'MANAGER', 'SECTOR_MANAGER', 'USER', 'STUDENT', 'SUPER_ADMIN'],
    labelEn: 'Search Records',
    labelMl: 'റെക്കോർഡുകൾ തിരയുക',
    promptEn: 'Search records in the current view',
    promptMl: 'ഈ പേജിലെ റെക്കോർഡുകൾ തിരയുക',
    action: { type: 'prefill_prompt', prompt: 'Search ' },
    priority: 92,
    icon: 'search',
  },
  {
    id: 'global.export-excel',
    pageIds: ['global', 'home'],
    roles: ['ADMIN', 'MANAGER', 'SECTOR_MANAGER', 'USER', 'STUDENT', 'SUPER_ADMIN'],
    labelEn: 'Export Excel',
    labelMl: 'Excel ഡൗൺലോഡ്',
    promptEn: 'Export current records as Excel',
    promptMl: 'ഈ വിവരങ്ങൾ Excel ആയി ഡൗൺലോഡ് ചെയ്യുക',
    action: { type: 'send_prompt', prompt: 'Export current data as Excel' },
    priority: 88,
    icon: 'download',
  },
  {
    id: 'global.export-pdf',
    pageIds: ['global', 'home'],
    roles: ['ADMIN', 'MANAGER', 'SECTOR_MANAGER', 'USER', 'STUDENT', 'SUPER_ADMIN'],
    labelEn: 'Export PDF',
    labelMl: 'PDF ഡൗൺലോഡ്',
    promptEn: 'Export current records as PDF',
    promptMl: 'ഈ വിവരങ്ങൾ PDF ആയി ഡൗൺലോഡ് ചെയ്യുക',
    action: { type: 'send_prompt', prompt: 'Export current data as PDF' },
    priority: 84,
    icon: 'file',
  },
  {
    id: 'global.guide-tour',
    pageIds: ['global', 'home'],
    roles: ['ADMIN', 'MANAGER', 'SECTOR_MANAGER', 'USER', 'STUDENT', 'SUPER_ADMIN', 'PUBLIC'],
    labelEn: 'Step-by-Step Guide',
    labelMl: 'ഗൈഡ് ടൂർ',
    promptEn: 'Show me how to use the AI Assistant features',
    promptMl: 'AI Assistant എങ്ങനെ ഉപയോഗിക്കാം എന്ന് കാണിക്കുക',
    action: { type: 'start_guide', guideId: 'quickstart_welcome', prompt: 'Guide me step by step' },
    priority: 80,
    icon: 'guide',
  },
  {
    id: 'auth.help',
    pageIds: ['auth.login'],
    roles: ['PUBLIC'],
    labelEn: 'Sign-In Help',
    labelMl: 'ലോഗിൻ സഹായം',
    promptEn: 'How do I sign in to my workspace?',
    promptMl: 'ഞാൻ എങ്ങനെ സൈൻ ഇൻ ചെയ്യും?',
    action: { type: 'send_prompt', prompt: 'How do I sign in to my workspace?' },
    priority: 95,
    icon: 'help',
  },
  {
    id: 'auth.features',
    pageIds: ['auth.login'],
    roles: ['PUBLIC'],
    labelEn: 'Assistant Features',
    labelMl: 'AI ഫീച്ചറുകൾ',
    promptEn: 'What can the AI Assistant help me with?',
    promptMl: 'AI Assistant എന്തിനെല്ലാം സഹായിക്കും?',
    action: { type: 'send_prompt', prompt: 'What can the AI Assistant help me with?' },
    priority: 90,
    icon: 'sparkles',
  },
];

const customChipTemplates: RegisteredChipTemplate[] = [];

export function registerEntityConfigChips(config: AssistantEntityConfig): void {
  if (!config.pages) return;
  for (const page of config.pages) {
    for (const action of page.actions || []) {
      const id = `cfg.${config.appId}.${page.pageId}.${action.id}`;
      if (customChipTemplates.some((c) => c.id === id)) continue;
      customChipTemplates.push({
        id,
        pageIds: [page.pageId, ...(page.routePatterns || [])],
        roles: (action.roles && action.roles.length > 0
          ? action.roles.map((r) => r.toUpperCase() as ScopeRole)
          : ['ADMIN', 'MANAGER', 'SECTOR_MANAGER', 'USER', 'STUDENT', 'SUPER_ADMIN']),
        labelEn: action.label,
        labelMl: action.labelMl,
        promptEn: action.prompt,
        promptMl: action.promptMl,
        action: { type: 'send_prompt', prompt: action.prompt },
        priority: 96,
      });
    }
  }
}

export function resolvePageId(routePath?: string): PageChipId {
  const clean = String(routePath || '').split('?')[0].split('#')[0].toLowerCase().trim();
  if (!clean || clean === '/') return 'home';
  if (/^\/(login|signin|sign-in|signup|sign-up|auth)(?:\/|$)/.test(clean)) {
    return 'auth.login';
  }
  return clean;
}

export function getRankedChips(params: {
  scope: AccessScope;
  pageId: PageChipId;
  lang: 'en' | 'ml';
  limit?: number;
  category?: string;
}): SuggestionChip[] {
  const limit = Math.max(1, Math.min(params.limit ?? 4, 8));
  const role = params.scope.role;
  const allTemplates = [...customChipTemplates, ...CHIP_REGISTRY];

  const matching = allTemplates.filter((chip) => {
    if (!chip.roles.includes(role)) return false;
    return (
      chip.pageIds.includes(params.pageId) ||
      chip.pageIds.includes('global') ||
      chip.pageIds.some((pid) => pid !== 'global' && params.pageId.startsWith(pid))
    );
  });

  const sorted = matching.sort((a, b) => {
    const aSpecific = a.pageIds.includes(params.pageId) ? 10 : 0;
    const bSpecific = b.pageIds.includes(params.pageId) ? 10 : 0;
    return b.priority + bSpecific - (a.priority + aSpecific);
  });

  return sorted.slice(0, limit).map((chip) => ({
    id: chip.id,
    label: params.lang === 'ml' && chip.labelMl ? chip.labelMl : chip.labelEn,
    prompt: params.lang === 'ml' && chip.promptMl ? chip.promptMl : chip.promptEn,
    action: chip.action,
    priority: chip.priority,
    icon: chip.icon,
  }));
}

export function isChipAllowedForScope(chipId: string, scope: AccessScope): boolean {
  const found = [...customChipTemplates, ...CHIP_REGISTRY].find((c) => c.id === chipId);
  if (!found) return true;
  return found.roles.includes(scope.role);
}
