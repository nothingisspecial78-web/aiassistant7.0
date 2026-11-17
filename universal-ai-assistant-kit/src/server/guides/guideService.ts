import {
  BUILTIN_DEFAULT_GUIDES,
  type GuideDef,
} from '../../core/index.ts';
import type { AccessScope } from '../security/scope.ts';

export interface GuideProgressRecord {
  userId: string;
  guideId: string;
  stepId: string;
  status: 'started' | 'step_reached' | 'completed' | 'abandoned' | 'error';
  updatedAt: string;
}

export interface GuideSearchMatch {
  guideId: string;
  title: { en: string; ml?: string };
  summary: { en: string; ml?: string };
  stepCount: number;
  startRoute?: string;
  score: number;
}

function normalizeScopeRole(scope?: AccessScope | null): string {
  const r = scope?.role || 'PUBLIC';
  if (r === 'SUPER_ADMIN') return 'super_admin';
  if (r === 'ADMIN') return 'admin';
  if (r === 'SECTOR_MANAGER' || r === 'MANAGER') return 'manager';
  if (r === 'STUDENT' || r === 'USER') return 'student';
  return 'public';
}

export function isGuideAllowedForScope(guide: GuideDef, scope?: AccessScope | null): boolean {
  if (guide.roles === 'public') return true;
  const roleStr = normalizeScopeRole(scope);
  if (roleStr === 'super_admin' || roleStr === 'admin') return true;
  if (roleStr === 'public') return false;
  return guide.roles.map((r) => r.toLowerCase()).includes(roleStr);
}

export class GuideService {
  private readonly guides: GuideDef[];
  private readonly progressStore = new Map<string, GuideProgressRecord[]>();
  private readonly counters = {
    started: new Map<string, number>(),
    completed: new Map<string, number>(),
    abandoned: new Map<string, number>(),
    errors: new Map<string, number>(),
  };

  constructor(customGuides: GuideDef[] = []) {
    const byId = new Map<string, GuideDef>();
    for (const g of [...BUILTIN_DEFAULT_GUIDES, ...customGuides]) {
      byId.set(g.guideId, g);
    }
    this.guides = Array.from(byId.values());
  }

  getAllGuides(): GuideDef[] {
    return this.guides;
  }

  getGuidesForScope(scope?: AccessScope | null): GuideDef[] {
    return this.guides.filter((g) => isGuideAllowedForScope(g, scope));
  }

  getGuideById(guideId: string, scope?: AccessScope | null): GuideDef | null {
    const g = this.guides.find((item) => item.guideId === guideId);
    if (!g) return null;
    if (scope && !isGuideAllowedForScope(g, scope)) return null;
    return g;
  }

  searchGuides(query: string, scope?: AccessScope | null, limit = 5): GuideSearchMatch[] {
    const q = (query || '').toLowerCase().trim();
    const tokens = q.split(/\s+/).filter((t) => t.length >= 2);
    const allowed = this.getGuidesForScope(scope);

    const scored: GuideSearchMatch[] = [];
    for (const g of allowed) {
      let score = 0;
      const haystack = [
        g.title.en,
        g.title.ml || '',
        g.summary.en,
        g.summary.ml || '',
        ...g.keywords,
      ]
        .join(' ')
        .toLowerCase();

      if (q && haystack.includes(q)) score += 6;
      for (const tok of tokens) {
        if (g.keywords.some((k) => k.toLowerCase().includes(tok))) score += 3;
        if (g.title.en.toLowerCase().includes(tok)) score += 2.5;
        if (haystack.includes(tok)) score += 1;
      }
      if (!q) score = 1;

      if (score > 0) {
        scored.push({
          guideId: g.guideId,
          title: g.title,
          summary: g.summary,
          stepCount: g.steps.length,
          startRoute: g.startRoute,
          score,
        });
      }
    }

    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  recordProgress(record: GuideProgressRecord): void {
    const list = this.progressStore.get(record.userId) || [];
    list.push(record);
    this.progressStore.set(record.userId, list.slice(-50));

    if (record.status === 'started') {
      this.counters.started.set(
        record.guideId,
        (this.counters.started.get(record.guideId) || 0) + 1
      );
    } else if (record.status === 'completed') {
      this.counters.completed.set(
        record.guideId,
        (this.counters.completed.get(record.guideId) || 0) + 1
      );
    } else if (record.status === 'abandoned') {
      this.counters.abandoned.set(
        record.guideId,
        (this.counters.abandoned.get(record.guideId) || 0) + 1
      );
    } else if (record.status === 'error') {
      this.counters.errors.set(
        record.guideId,
        (this.counters.errors.get(record.guideId) || 0) + 1
      );
    }
  }

  getAnalytics() {
    return {
      totalGuides: this.guides.length,
      started: Object.fromEntries(this.counters.started),
      completed: Object.fromEntries(this.counters.completed),
      abandoned: Object.fromEntries(this.counters.abandoned),
      errors: Object.fromEntries(this.counters.errors),
    };
  }
}
