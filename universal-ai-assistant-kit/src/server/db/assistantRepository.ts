import crypto from 'node:crypto';
import type { ServerConfig } from '../config.ts';
import type { AccessScope } from '../security/scope.ts';

export interface StoredMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

export interface StoredMemory {
  key: string;
  value: string;
  updatedAt: string;
}

export class AssistantRepository {
  private readonly messages = new Map<string, StoredMessage[]>();
  private readonly memories = new Map<string, StoredMemory[]>();
  private readonly guideProgress = new Map<string, Record<string, unknown>>();
  private readonly guideAnalytics: Array<Record<string, unknown>> = [];
  private readonly chipUsages = new Map<string, Map<string, { impressions: number; clicks: number; lastUsedAt?: string }>>();

  constructor(_cfg?: ServerConfig) {}

  async ensureConversation(
    conversationId: string,
    _scope: AccessScope
  ): Promise<string> {
    if (!this.messages.has(conversationId)) {
      this.messages.set(conversationId, []);
    }
    return conversationId;
  }

  async appendMessage(
    conversationId: string,
    _scope: AccessScope,
    role: 'user' | 'assistant',
    content: string
  ): Promise<void> {
    const list = this.messages.get(conversationId) || [];
    list.push({
      id: `msg_${crypto.randomUUID().slice(0, 10)}`,
      conversationId,
      role,
      content,
      createdAt: new Date().toISOString(),
    });
    this.messages.set(conversationId, list.slice(-100));
  }

  async getConversationMessages(conversationId: string): Promise<StoredMessage[]> {
    return this.messages.get(conversationId) || [];
  }

  async getRecentMessages(conversationId: string, limit = 12): Promise<StoredMessage[]> {
    const list = this.messages.get(conversationId) || [];
    return list.slice(-limit);
  }

  async saveUserMemory(
    userId: string,
    _orgId: string | undefined,
    key: string,
    value: string
  ): Promise<void> {
    const list = this.memories.get(userId) || [];
    const idx = list.findIndex((m) => m.key === key);
    const entry: StoredMemory = { key, value, updatedAt: new Date().toISOString() };
    if (idx >= 0) list[idx] = entry;
    else list.push(entry);
    this.memories.set(userId, list.slice(-50));
  }

  async getUserMemories(userId: string): Promise<StoredMemory[]> {
    return this.memories.get(userId) || [];
  }

  async getUserProfile(
    _userId: string
  ): Promise<{ preferredLanguage?: string; tone?: string; customInstructions?: string } | null> {
    return null;
  }

  async getChipUsages(
    userId: string
  ): Promise<Record<string, { impressions: number; clicks: number; lastUsedAt?: string }>> {
    const map = this.chipUsages.get(userId);
    if (!map) return {};
    return Object.fromEntries(map.entries());
  }

  async recordChipImpression(userId: string, chipId: string): Promise<void> {
    let map = this.chipUsages.get(userId);
    if (!map) {
      map = new Map();
      this.chipUsages.set(userId, map);
    }
    const existing = map.get(chipId) || { impressions: 0, clicks: 0 };
    existing.impressions += 1;
    map.set(chipId, existing);
  }

  async recordChipClick(userId: string, chipId: string): Promise<void> {
    let map = this.chipUsages.get(userId);
    if (!map) {
      map = new Map();
      this.chipUsages.set(userId, map);
    }
    const existing = map.get(chipId) || { impressions: 0, clicks: 0 };
    existing.clicks += 1;
    existing.lastUsedAt = new Date().toISOString();
    map.set(chipId, existing);
  }

  async recordGuideProgress(input: {
    userId: string;
    guideId: string;
    currentStepId: string;
    completedSteps: string[];
    status: string;
  }): Promise<void> {
    this.guideProgress.set(`${input.userId}:${input.guideId}`, {
      ...input,
      updatedAt: new Date().toISOString(),
    });
  }

  async recordGuideAnalytic(event: Record<string, unknown>): Promise<void> {
    this.guideAnalytics.unshift({ ...event, createdAt: new Date().toISOString() });
    if (this.guideAnalytics.length > 500) this.guideAnalytics.length = 500;
  }

  async getGuideAnalyticsOverview(): Promise<{
    totalEvents: number;
    recentEvents: Array<Record<string, unknown>>;
  }> {
    return {
      totalEvents: this.guideAnalytics.length,
      recentEvents: this.guideAnalytics.slice(0, 50),
    };
  }
}
