import type { ChatMessage } from '../../core/index.ts';
import { logger, type ServerConfig } from '../config.ts';
import type { AssistantRepository } from '../db/assistantRepository.ts';
import type { AccessScope } from '../security/scope.ts';
import type { LlmGateway } from './client.ts';

const SENSITIVE_ARG_KEY_PATTERN = /(pass(word)?|secret|token|api[-_]?key|auth(orization)?|credential|pin|otp)/i;

export function redactSensitiveToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args || {})) {
    if (SENSITIVE_ARG_KEY_PATTERN.test(k)) {
      out[k] = '[REDACTED]';
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = redactSensitiveToolArgs(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export async function summarizeConversationBackground(params: {
  conversationId: string;
  scope: AccessScope;
  messages: ChatMessage[];
  repository: AssistantRepository;
  llm: LlmGateway;
  cfg: ServerConfig;
}): Promise<void> {
  const { conversationId, scope, messages, repository, llm, cfg } = params;
  try {
    const textHistory = messages
      .slice(-16)
      .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
      .join('\n');

    const prompt = `Summarize the key facts from this conversation in 3 concise sentences, focusing on user goals, entities discussed, and completed actions.\n\n${textHistory}`;

    let summary = '';
    if (llm.hasLiveProvider) {
      const res = await llm.streamChat({
        model: cfg.modelFast,
        messages: [{ role: 'user', content: prompt }],
        onDelta: (delta) => {
          summary += delta;
        },
      });
      summary = res.fullText.trim();
    } else {
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      summary = `User discussed ${lastUser?.content.slice(0, 80) || 'workspace tasks'}.`;
    }

    if (summary) {
      const orgId = 'organizationId' in scope ? scope.organizationId : undefined;
      await repository.saveUserMemory(scope.userId, orgId, `summary:${conversationId}`, summary);
    }
  } catch (err) {
    logger.warn({ err, conversationId }, 'Background conversation summary failed');
  }
}
