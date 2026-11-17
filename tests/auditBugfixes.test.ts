import { describe, expect, it } from 'vitest';
import type { AssistantSseEvent } from '@ai-assistant/core';
import { getRegisteredEntityConfig, searchEntities } from '../packages/server/src/entityRegistry/searchEngine.ts';
import { scopedRepository } from '../packages/server/src/db/scopedDataRepository.ts';
import { loadConfig } from '../packages/server/src/config.ts';
import { ProfileRegistry } from '../packages/server/src/profiles/loader.ts';
import { InMemoryVectorStore } from '../packages/server/src/rag/store.ts';
import { createEmbedder } from '../packages/server/src/rag/embedder.ts';
import { ToolRegistry } from '../packages/server/src/tools/registry.ts';
import { ActionLogStore } from '../packages/server/src/security/confirmation.ts';
import { ResponseCache } from '../packages/server/src/security/limits.ts';
import { createLlmGateway } from '../packages/server/src/llm/client.ts';
import { runChatAgent } from '../packages/server/src/llm/agentLoop.ts';
import {
  extractEntitySearchQuery,
  extractExportToolCall,
  inferDeterministicToolCall,
} from '../packages/server/src/llm/intentParser.ts';
import { khaznaAssistantConfig } from '../packages/core/src/defaultEntityConfigs.ts';
import { sanitizeLoadedThreads } from '../packages/widget/src/hooks/useChatStorage.ts';
import { isSafeMarkdownUrl } from '../packages/widget/src/components/MessageList.tsx';
import { RazorpayPaymentProvider } from '../packages/server/src/billing/paymentProvider.ts';
import { readOfflineQueue } from '../src/lib/network/offlineQueue.ts';
import { RestDataAdapter } from '../packages/core/src/adapters/rest.ts';

describe('Audit Bugfix Regressions (B-001 to B-028)', () => {
  it('B-001: provides built-in entity configs automatically without manual registerEntityConfig', async () => {
    expect(getRegisteredEntityConfig('khazna-ledger')).toBeDefined();
    expect(getRegisteredEntityConfig('second-demo')).toBeDefined();
    expect(getRegisteredEntityConfig('leave-log')).toBeDefined();

    const cfg = loadConfig({ openRouterApiKey: '', groqApiKey: '', geminiApiKey: '' });
    const profiles = new ProfileRegistry();
    await profiles.loadAll(cfg.profilesDir);
    const khaznaProfile = profiles.getProfile('khazna-ledger')!;

    const events: AssistantSseEvent[] = [];
    await runChatAgent({
      profile: khaznaProfile,
      messages: [
        {
          id: 'u1',
          role: 'user',
          content: 'who is Ustad doctor Hamza',
          createdAt: new Date().toISOString(),
        },
      ],
      appState: { activeOrgId: 'demo', role: 'admin', pathname: '/admin/admins' },
      userId: 'admin-demo',
      authToken: '',
      cfg,
      embedder: createEmbedder(cfg),
      vectorStore: new InMemoryVectorStore(),
      llm: createLlmGateway(cfg),
      toolRegistry: new ToolRegistry(),
      actionStore: new ActionLogStore(),
      cache: new ResponseCache(0),
      emit: (e) => events.push(e),
      scope: { role: 'ADMIN', userId: 'admin-demo', organizationId: 'demo' },
    });

    const answer = events
      .filter((e): e is Extract<AssistantSseEvent, { type: 'token' }> => e.type === 'token')
      .map((e) => e.delta)
      .join('');
    expect(answer).not.toContain('No entity registry config found');
    expect(answer).toContain('Hamza Saqafi');
  });

  it('B-002 & B-010: strips stacked honorifics and matches normalized titles ("Usthad" vs "Ustad", "Dr." vs "doctor")', async () => {
    const parsed = extractEntitySearchQuery('who is Ustad doctor Hamza');
    expect(parsed?.query).toBe('Hamza');

    const collections = scopedRepository.getEntityCollections();
    const res = await searchEntities({
      config: khaznaAssistantConfig,
      collections,
      query: 'Ustad doctor Hamza',
      scope: { role: 'ADMIN', userId: 'admin-demo', organizationId: 'demo' },
    });

    expect(res.ok).toBe(true);
    expect(res.matches.length).toBeGreaterThan(0);
    expect(res.matches.some((m) => /Hamza/i.test(m.name))).toBe(true);
  });

  it('B-003: resolves route-aware "PDF of this details" on /admin/admins to sector_manager without returning student table', async () => {
    const toolCall1 = extractExportToolCall("don't my typing can you download the PDF of this details", '/admin/admins');
    expect(toolCall1?.name).toBe('export_data');
    expect(toolCall1?.args.entityType).toBe('sector_manager');
    expect(toolCall1?.args.format).toBe('pdf');

    const cfg = loadConfig({ openRouterApiKey: '', groqApiKey: '', geminiApiKey: '' });
    const profiles = new ProfileRegistry();
    await profiles.loadAll(cfg.profilesDir);
    const khaznaProfile = profiles.getProfile('khazna-ledger')!;
    const toolRegistry = new ToolRegistry();
    const adminScope = { role: 'ADMIN' as const, userId: 'admin-demo', organizationId: 'demo' };
    const toolMap = toolRegistry.getToolsForProfile(khaznaProfile, adminScope);
    const toolCall2 = inferDeterministicToolCall(
      'I am not asking for about in the Angry but only asking to download the PDF of this detail',
      toolMap,
      [],
      undefined,
      undefined,
      { routePath: '/admin/admins' }
    );
    expect(toolCall2?.name).toBe('export_data');
    expect(toolCall2?.args.entityType).toBe('sector_manager');
    expect(toolCall2?.args.format).toBe('pdf');

    const events: AssistantSseEvent[] = [];

    await runChatAgent({
      profile: khaznaProfile,
      messages: [
        {
          id: 'u2',
          role: 'user',
          content: "don't my typing can you download the PDF of this details",
          createdAt: new Date().toISOString(),
        },
      ],
      appState: { activeOrgId: 'demo', role: 'admin', pathname: '/admin/admins' },
      userId: 'admin-demo',
      authToken: '',
      cfg,
      embedder: createEmbedder(cfg),
      vectorStore: new InMemoryVectorStore(),
      llm: createLlmGateway(cfg),
      toolRegistry: new ToolRegistry(),
      actionStore: new ActionLogStore(),
      cache: new ResponseCache(0),
      emit: (e) => events.push(e),
      scope: { role: 'ADMIN', userId: 'admin-demo', organizationId: 'demo' },
    });

    const exportEvents = events.filter((e) => e.type === 'export_file');
    expect(exportEvents.length).toBeGreaterThan(0);
    const answer = events
      .filter((e): e is Extract<AssistantSseEvent, { type: 'token' }> => e.type === 'token')
      .map((e) => e.delta)
      .join('');
    expect(answer).not.toContain('No entity registry config found');
  });

  it('B-004: sanitizeLoadedThreads clears stale isStreaming flags and empty interrupted assistant bubbles', () => {
    const sanitized = sanitizeLoadedThreads([
      {
        id: 't1',
        title: 'Test Thread',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: [
          {
            id: 'm1',
            role: 'user',
            content: 'open the ledger',
          },
          {
            id: 'm2',
            role: 'assistant',
            content: '',
            isStreaming: true,
            statusLabel: 'Analyzing request...',
          },
          {
            id: 'm3',
            role: 'assistant',
            content: 'Partial reply',
            isStreaming: true,
            statusLabel: 'Still streaming',
          },
        ],
      },
    ]);

    expect(sanitized[0]!.messages).toHaveLength(3);
    expect(sanitized[0]!.messages[1]!.id).toBe('m2');
    expect(sanitized[0]!.messages[1]!.isStreaming).toBe(false);
    expect(sanitized[0]!.messages[1]!.statusLabel).toBeUndefined();
    expect(sanitized[0]!.messages[1]!.content).toBe('Previous response was interrupted before completion.');
    expect(sanitized[0]!.messages[2]!.id).toBe('m3');
    expect(sanitized[0]!.messages[2]!.isStreaming).toBe(false);
    expect(sanitized[0]!.messages[2]!.statusLabel).toBeUndefined();
    expect(sanitized[0]!.messages[2]!.content).toBe('Partial reply');
  });

  it('B-014: rejects unsafe markdown link schemes and allows safe https/http/mailto/relative URLs', () => {
    expect(isSafeMarkdownUrl('https://islahululoom.edu.in')).toBe(true);
    expect(isSafeMarkdownUrl('http://localhost:3000/admin')).toBe(true);
    expect(isSafeMarkdownUrl('mailto:accounts@islahululoom.edu.in')).toBe(true);
    expect(isSafeMarkdownUrl('/admin/students')).toBe(true);

    expect(isSafeMarkdownUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeMarkdownUrl('JAVASCRIPT:void(0)')).toBe(false);
    expect(isSafeMarkdownUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isSafeMarkdownUrl('vbscript:msgbox(1)')).toBe(false);
    expect(isSafeMarkdownUrl('//evil.example.com/phish')).toBe(false);
  });

  it('B-027 & B-028: guards malformed webhook JSON payloads, throwing storage, and forwards request timeout signal', async () => {
    const provider = new RazorpayPaymentProvider({
      razorpayKeyId: '',
      razorpayKeySecret: '',
      razorpayWebhookSecret: '',
      razorpayTestMode: true,
    });
    const badWebhook = provider.parseWebhookPayload('{not valid json', 'evt_bad_1');
    expect(badWebhook.handled).toBe(false);
    expect(badWebhook.reason).toBe('Invalid JSON webhook payload');

    const brokenStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
    };
    expect(readOfflineQueue(brokenStorage)).toEqual([]);

    let receivedSignal = false;
    const adapter = new RestDataAdapter({
      baseUrl: 'https://example.test/api',
      timeoutMs: 2500,
      fetchFn: async (_input, init) => {
        receivedSignal = Boolean(init?.signal);
        return new Response(JSON.stringify([{ id: '1', name: 'Row' }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });
    const rows = await adapter.search('students', 'Row');
    expect(rows).toHaveLength(1);
    expect(receivedSignal).toBe(true);
  });
});
