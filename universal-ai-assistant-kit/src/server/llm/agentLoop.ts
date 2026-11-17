import crypto from 'node:crypto';
import type {
  AppProfile,
  AssistantSseEvent,
  ChatAttachment,
  ChatMessage,
  DataAdapter,
  PersonalizationSettings,
  RetrievedChunk,
  RightClickContext,
} from '../../core/index.ts';
import { getRankedChips, resolvePageId } from '../chips/pageRegistry.ts';
import type { BillingStatusSnapshot } from '../billing/types.ts';
import { logger, type ServerConfig } from '../config.ts';
import type { GuideService } from '../guides/guideService.ts';
import {
  createConfirmationToken,
  type ActionLogStore,
} from '../security/confirmation.ts';
import { detectLanguage, redactPiiForLog, wrapUntrustedData } from '../security/sanitize.ts';
import type { AccessScope } from '../security/scope.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type { HostDataResolver, ToolDefinition } from '../tools/types.ts';
import type { LlmChatMessage, LlmGateway, OpenAiToolSpec } from './client.ts';
import { compressScreenshotDataUrl } from './client.ts';
import { inferDeterministicToolCall } from './intentParser.ts';
import { buildSystemPrompt, trimHistoryToBudget } from './prompts.ts';
import { redactSensitiveToolArgs } from './summarizer.ts';

export interface AgentRunResult {
  refusal: boolean;
  model: string;
  topScore: number;
  citations: Array<{ source: string; heading: string; score: number }>;
  latencyMs: number;
  provider?: string;
}

const FORCE_DIRECT_RESPONSE_TOOLS = new Set([
  'export_data',
  'query_entities',
  'search_entities',
  'get_entity_details',
  'search_guides',
  'start_guide',
  'controlAppUi',
]);

async function buildUserTurnContent(params: {
  question: string;
  attachments?: ChatAttachment[];
  cfg: ServerConfig;
}): Promise<LlmChatMessage['content']> {
  const { question, attachments = [] } = params;
  if (attachments.length === 0) return question;

  const parts: Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } }
    | { type: 'file_data'; file_data: { fileUri: string; mimeType: string } }
  > = [{ type: 'text', text: question }];

  for (const att of attachments.slice(0, 5)) {
    if (att.type === 'image' && att.dataUrl) {
      const compressed = await compressScreenshotDataUrl(att.dataUrl);
      parts.push({ type: 'image_url', image_url: { url: compressed } });
    } else if (att.geminiFileUri) {
      parts.push({
        type: 'file_data',
        file_data: { fileUri: att.geminiFileUri, mimeType: att.mimeType },
      });
    } else if (att.extractedText || att.previewSummary) {
      parts.push({
        type: 'text',
        text: wrapUntrustedData(
          `attachment_${att.name}`,
          att.extractedText || att.previewSummary || ''
        ),
      });
    }
  }

  return parts;
}

export async function runChatAgent(params: {
  profile: AppProfile;
  cfg: ServerConfig;
  llm: LlmGateway;
  toolRegistry: ToolRegistry;
  actionStore: ActionLogStore;
  guideService?: GuideService;
  dataAdapter?: DataAdapter;
  resolveData?: HostDataResolver;
  userId: string;
  authToken: string;
  scope?: AccessScope;
  conversationId?: string;
  question: string;
  messages: ChatMessage[];
  context?: RightClickContext;
  contexts?: RightClickContext[];
  attachments?: ChatAttachment[];
  appState?: Record<string, unknown>;
  personalization?: PersonalizationSettings;
  language?: string;
  retrieval: {
    chunks: RetrievedChunk[];
    topScore: number;
    citations: Array<{ source: string; heading: string; score: number }>;
  };
  billingStatus?: BillingStatusSnapshot;
  emit: (event: AssistantSseEvent) => void;
  signal?: AbortSignal;
}): Promise<AgentRunResult> {
  const startMs = Date.now();
  const {
    profile,
    cfg,
    llm,
    toolRegistry,
    actionStore,
    guideService,
    dataAdapter,
    resolveData,
    userId,
    authToken,
    scope,
    conversationId,
    question,
    messages,
    context,
    contexts,
    attachments = [],
    appState,
    personalization,
    language,
    retrieval,
    billingStatus,
    emit,
    signal,
  } = params;

  const detectedLang: 'en' | 'ml' =
    language === 'ml'
      ? 'ml'
      : language === 'en'
        ? 'en'
        : detectLanguage(question);

  const mergedContexts = contexts && contexts.length > 0 ? contexts : context ? [context] : [];
  const toolsMap = toolRegistry.getToolsForProfile(profile, scope);
  const availableToolNames = Array.from(toolsMap.keys());
  const hasImage = attachments.some((a) => a.type === 'image');

  const systemPrompt = buildSystemPrompt({
    profile,
    chunks: retrieval.chunks,
    language: detectedLang,
    context: mergedContexts[0],
    contexts: mergedContexts,
    hasScreenshot: hasImage,
    availableTools: availableToolNames,
    agentMode: availableToolNames.length > 0,
    appState,
    personalization,
    scope,
    userId,
    billingStatus,
  });

  const historyTrimmed = trimHistoryToBudget(messages.slice(0, -1));
  const userContent = await buildUserTurnContent({
    question,
    attachments,
    cfg,
  });

  const llmMessages: LlmChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...historyTrimmed.map((m) => ({
      role: m.role as 'user' | 'assistant' | 'system',
      content: m.content,
    })),
    { role: 'user', content: userContent },
  ];

  const openAiTools: OpenAiToolSpec[] = Array.from(toolsMap.values()).map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.jsonParameters,
    },
  }));

  const defaultScope: AccessScope = scope || {
    role: 'ADMIN',
    userId,
    organizationId: 'default',
  };

  const emitDoneAndChips = (opts: {
    model: string;
    actionLogId?: string;
    provider?: string;
    chips?: Array<{ id: string; label: string; prompt: string }>;
  }): AgentRunResult => {
    const chips =
      opts.chips && opts.chips.length > 0
        ? opts.chips
        : getRankedChips({
            scope: defaultScope,
            pageId: resolvePageId(
              mergedContexts[0]?.routePath || (appState?.pathname as string) || ''
            ),
            lang: detectedLang,
            limit: 3,
          });
    emit({ type: 'follow_up_chips', chips });
    const latencyMs = Date.now() - startMs;
    emit({
      type: 'done',
      refusal: false,
      model: opts.model,
      latencyMs,
      sources: retrieval.citations,
      actionLogId: opts.actionLogId,
      provider: opts.provider,
    });
    return {
      refusal: false,
      model: opts.model,
      topScore: retrieval.topScore,
      citations: retrieval.citations,
      latencyMs,
      provider: opts.provider,
    };
  };

  let lastActionLogId: string | undefined;
  let modelUsed = cfg.modelStrong;
  let providerUsed: string | undefined;

  // Deterministic pre-check for explicit intents (works both offline & online)
  const deterministicCall = inferDeterministicToolCall({
    question,
    tools: toolsMap,
    appId: profile.appId,
    conversationId,
    scope,
    guideService,
  });

  const maxSteps = 6;
  for (let step = 0; step < maxSteps; step += 1) {
    if (signal?.aborted) break;

    let toolCallsToRun: Array<{ id: string; name: string; argumentsJson: string }> = [];
    let finalText = '';

    if (step === 0 && deterministicCall) {
      toolCallsToRun = [
        {
          id: `det_${crypto.randomUUID().slice(0, 8)}`,
          name: deterministicCall.name,
          argumentsJson: JSON.stringify(deterministicCall.args),
        },
      ];
      modelUsed = 'deterministic-intent';
      providerUsed = 'local';
    } else if (openAiTools.length > 0 && llm.hasLiveProvider) {
      emit({
        type: 'status',
        phase: step === 0 ? 'analyzing' : 'synthesizing',
        label: step === 0 ? 'Analyzing request…' : 'Synthesizing answer…',
      });
      const completion = await llm.completeWithTools({
        model: cfg.modelStrong,
        messages: llmMessages,
        tools: openAiTools,
        retrievedChunks: retrieval.chunks,
        language: detectedLang,
        signal,
      });
      modelUsed = completion.modelUsed;
      providerUsed = completion.provider;
      finalText = completion.content;
      toolCallsToRun = completion.toolCalls;
    }

    if (toolCallsToRun.length === 0) {
      if (finalText) {
        emit({ type: 'status', phase: 'responding', label: 'Writing answer…' });
        for (const chunk of finalText.split(/(\s+)/)) {
          if (chunk) emit({ type: 'token', delta: chunk });
        }
        return emitDoneAndChips({
          model: modelUsed,
          actionLogId: lastActionLogId,
          provider: providerUsed,
        });
      }

      emit({ type: 'status', phase: 'responding', label: 'Writing answer…' });
      const streamed = await llm.streamChat({
        model: cfg.modelFast,
        messages: llmMessages,
        retrievedChunks: retrieval.chunks,
        language: detectedLang,
        signal,
        onDelta: (delta) => emit({ type: 'token', delta }),
        onStreamReset: () => emit({ type: 'stream_reset', reason: 'provider_fallback' }),
      });
      return emitDoneAndChips({
        model: streamed.modelUsed,
        actionLogId: lastActionLogId,
        provider: streamed.provider,
      });
    }

    llmMessages.push({
      role: 'assistant',
      content: finalText || '',
      tool_calls: toolCallsToRun.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.argumentsJson },
      })),
    });

    for (const tc of toolCallsToRun) {
      const tool: ToolDefinition | undefined = toolsMap.get(tc.name);
      if (!tool) {
        llmMessages.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: tc.name,
          content: JSON.stringify({ error: `Tool "${tc.name}" is unavailable.` }),
        });
        continue;
      }

      let rawArgs: Record<string, unknown> = {};
      try {
        rawArgs = tc.argumentsJson ? (JSON.parse(tc.argumentsJson) as Record<string, unknown>) : {};
      } catch {
        rawArgs = {};
      }

      const validated = tool.inputSchema.safeParse(rawArgs);
      if (!validated.success) {
        const errMsg = validated.error.issues.map((i) => i.message).join('; ');
        llmMessages.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: tc.name,
          content: JSON.stringify({ error: `Invalid arguments: ${errMsg}` }),
        });
        continue;
      }

      const cleanArgs = validated.data as Record<string, unknown>;
      const safeArgs = redactSensitiveToolArgs(cleanArgs);

      if (tool.risk === 'write' && !tool.autoExecute) {
        const actionId = `act_${crypto.randomUUID()}`;
        const summary = tool.summarize(cleanArgs);
        const { token, expiresAt } = createConfirmationToken(
          {
            actionId,
            appId: profile.appId,
            userId,
            toolName: tool.name,
            args: safeArgs,
          },
          cfg.confirmationSecret
        );

        actionStore.savePendingAction(
          {
            id: actionId,
            appId: profile.appId,
            userId,
            toolName: tool.name,
            risk: 'write',
            status: 'pending',
            summary,
            args: safeArgs,
            createdIds: [],
            createdAt: new Date().toISOString(),
          },
          cleanArgs
        );

        emit({
          type: 'confirmation_required',
          actionId,
          confirmationToken: token,
          toolName: tool.name,
          summary,
          details: safeArgs,
          expiresAt,
        });

        emit({ type: 'status', phase: 'completed', label: 'Confirmation ready' });
        emit({
          type: 'token',
          delta: `I have prepared the action: **${summary}**. Please review and click **Confirm** to execute.`,
        });
        return emitDoneAndChips({
          model: modelUsed,
          actionLogId: actionId,
          provider: providerUsed,
        });
      }

      emit({ type: 'status', phase: 'reading_info', label: `Running ${tool.name}…` });
      emit({
        type: 'tool_call',
        toolName: tool.name,
        risk: tool.risk,
        args: safeArgs,
        status: 'running',
      });

      try {
        const result = await tool.execute(cleanArgs, {
          appId: profile.appId,
          profile,
          userId,
          authToken,
          cfg,
          actionStore,
          appState,
          scope,
          conversationId,
          dataAdapter,
          resolveData,
          guideService,
        });

        const logId = `act_${crypto.randomUUID()}`;
        lastActionLogId = logId;
        actionStore.recordImmediateAction({
          id: logId,
          appId: profile.appId,
          userId,
          toolName: tool.name,
          risk: tool.risk,
          status: result.ok ? 'executed' : 'failed',
          summary: result.summary,
          args: safeArgs,
          result: result.data,
          createdIds: result.createdIds || [],
          createdAt: new Date().toISOString(),
          executedAt: new Date().toISOString(),
        });

        emit({
          type: 'tool_call',
          toolName: tool.name,
          risk: tool.risk,
          args: safeArgs,
          status: result.ok ? 'completed' : 'failed',
          summary: result.summary,
        });

        if (tool.risk === 'write' && result.ok) {
          emit({
            type: 'action_executed',
            actionId: logId,
            toolName: tool.name,
            summary: result.summary,
            details: safeArgs,
            canUndo: Boolean(tool.undo),
          });
        }

        if (result.formRequest) {
          emit({ type: 'status', phase: 'completed', label: 'Input form ready' });
          emit({ type: 'form_request', form: result.formRequest });
          emit({ type: 'token', delta: result.summary });
          return emitDoneAndChips({
            model: modelUsed,
            actionLogId: logId,
            provider: providerUsed,
            chips: result.followUpChips,
          });
        }

        if (result.uiAction) {
          emit({
            type: 'status',
            phase: 'locating_section',
            label: result.uiAction.label || 'Updating UI…',
          });
          emit({
            type: 'ui_action',
            actionId: logId,
            action: result.uiAction.action,
            selector: result.uiAction.selector,
            fallbackTabSelector: result.uiAction.fallbackTabSelector,
            value: result.uiAction.value,
            highlightSelector: result.uiAction.highlightSelector,
            refreshApp: result.uiAction.refreshApp,
            cursorWaypoints: result.uiAction.cursorWaypoints,
            followUpActions: result.uiAction.followUpActions,
            appCommand: result.uiAction.appCommand,
            label: result.uiAction.label,
          });
          if (tool.name === 'start_guide') {
            emit({
              type: 'start_guide',
              guideId: String(cleanArgs.guideId || ''),
              startStep:
                typeof cleanArgs.startStep === 'string' ? cleanArgs.startStep : undefined,
            });
          }
          emit({ type: 'status', phase: 'completed', label: 'Completed' });
          emit({ type: 'token', delta: result.summary });
          return emitDoneAndChips({
            model: modelUsed,
            actionLogId: logId,
            provider: providerUsed,
            chips: result.followUpChips,
          });
        }

        if (
          !llm.hasLiveProvider ||
          result.ok === false ||
          result.exportFile ||
          FORCE_DIRECT_RESPONSE_TOOLS.has(tool.name)
        ) {
          if (result.exportFile) {
            emit({ type: 'export_file', exportFile: result.exportFile });
          }
          emit({
            type: 'status',
            phase: result.ok ? 'completed' : 'failed',
            label: result.ok ? 'Completed' : 'Notice',
          });
          emit({ type: 'token', delta: result.summary });
          return emitDoneAndChips({
            model: modelUsed,
            actionLogId: logId,
            provider: providerUsed,
            chips: result.followUpChips,
          });
        }

        llmMessages.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: tool.name,
          content: wrapUntrustedData(`tool_${tool.name}`, JSON.stringify(result.data)),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Tool execution failed';
        logger.warn(
          { err: redactPiiForLog(message), tool: tool.name, appId: profile.appId },
          'Tool execution error'
        );
        emit({
          type: 'tool_call',
          toolName: tool.name,
          risk: tool.risk,
          args: safeArgs,
          status: 'failed',
          summary: message,
        });
        llmMessages.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: tc.name,
          content: JSON.stringify({ error: message }),
        });
      }
    }
  }

  emit({
    type: 'token',
    delta: 'Reached the maximum reasoning steps. Please refine your request.',
  });
  return emitDoneAndChips({ model: modelUsed, actionLogId: lastActionLogId, provider: providerUsed });
}
