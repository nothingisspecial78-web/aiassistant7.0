import {
  DEFAULT_IMAGE_MAX_WIDTH,
  DEFAULT_IMAGE_QUALITY,
  type RetrievedChunk,
} from '../../core/index.ts';
import { logger, type ServerConfig } from '../config.ts';
import { ProviderFallbackChain } from './providerChain.ts';

export interface LlmChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content:
    | string
    | Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string } }
        | { type: 'file_data'; file_data: { fileUri: string; mimeType: string } }
      >;
  tool_call_id?: string;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

export interface OpenAiToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface LlmCompletionResult {
  content: string;
  toolCalls: Array<{ id: string; name: string; argumentsJson: string }>;
  modelUsed: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export async function compressScreenshotDataUrl(dataUrl: string): Promise<string> {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) return dataUrl;
  const rawBuffer = Buffer.from(match[2], 'base64');

  try {
    const sharpMod = await import('sharp').catch(() => null);
    const sharpFn = sharpMod?.default as
      | ((buf: Buffer) => {
          resize: (opts: { width: number; withoutEnlargement: boolean }) => {
            jpeg: (opts: { quality: number; mozjpeg: boolean }) => {
              toBuffer: () => Promise<Buffer>;
            };
          };
        })
      | undefined;

    if (!sharpFn) return dataUrl;

    const compressed = await sharpFn(rawBuffer)
      .resize({ width: DEFAULT_IMAGE_MAX_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: DEFAULT_IMAGE_QUALITY, mozjpeg: true })
      .toBuffer();
    return `data:image/jpeg;base64,${compressed.toString('base64')}`;
  } catch (err) {
    logger.warn({ err }, 'Sharp compression skipped; forwarding original image');
    return dataUrl;
  }
}

export interface LlmGateway {
  readonly hasLiveProvider: boolean;
  readonly chain: ProviderFallbackChain;
  streamChat(params: {
    model: string;
    messages: LlmChatMessage[];
    onDelta: (text: string) => void;
    onStreamReset?: () => void;
    retrievedChunks?: RetrievedChunk[];
    language?: 'en' | 'ml';
    signal?: AbortSignal;
  }): Promise<{
    fullText: string;
    modelUsed: string;
    provider?: string;
    ttftMs?: number;
    totalMs?: number;
    usage?: LlmCompletionResult['usage'];
  }>;

  completeWithTools(params: {
    model: string;
    messages: LlmChatMessage[];
    tools: OpenAiToolSpec[];
    retrievedChunks?: RetrievedChunk[];
    language?: 'en' | 'ml';
    signal?: AbortSignal;
  }): Promise<LlmCompletionResult & { provider?: string }>;
}

function buildGroundedLocalAnswer(
  messages: LlmChatMessage[],
  chunks: RetrievedChunk[],
  language: 'en' | 'ml'
): string {
  const lastTool = [...messages]
    .reverse()
    .find((m) => m.role === 'tool' && typeof m.content === 'string');
  if (lastTool && typeof lastTool.content === 'string') {
    const raw = lastTool.content
      .replace(/^<untrusted_data[^>]*>\s*/i, '')
      .replace(/\s*<\/untrusted_data>$/i, '')
      .trim();
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed.formattedReport === 'string' && parsed.formattedReport.trim()) {
        return parsed.formattedReport;
      }
      if (typeof parsed.summary === 'string' && parsed.summary.trim()) {
        return parsed.summary;
      }
      if (typeof parsed.error === 'string' && parsed.error.trim()) {
        return parsed.error;
      }
    } catch {
      if (raw) return raw.slice(0, 1800);
    }
  }

  const sysMsg = messages.find((m) => m.role === 'system');
  const sysText = typeof sysMsg?.content === 'string' ? sysMsg.content : '';
  const uiMatch = /<untrusted_data source="ui_context">\s*(\{[\s\S]*?\})\s*<\/untrusted_data>/i.exec(
    sysText
  );
  if (uiMatch) {
    try {
      const ui = JSON.parse(uiMatch[1]) as {
        nearbyLabel?: string;
        text?: string;
        routePath?: string;
      };
      const label = (ui.nearbyLabel || '').trim();
      const snippet = (ui.text || '').replace(/\s+/g, ' ').trim();
      if (label || snippet) {
        const subject = label || snippet.slice(0, 60);
        const detail = snippet && snippet !== label ? ` (${snippet.slice(0, 120)})` : '';
        return language === 'ml'
          ? `ഈ ഭാഗം നിലവിലെ വെബ് ആപ്പിൽ ഉള്ള **${subject}** വിവരങ്ങളാണ് കാണിക്കുന്നത്${detail}.`
          : `This shows the **${subject}** section currently displayed in this application${detail}.`;
      }
    } catch {
      // fall through to docs synthesis
    }
  }

  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const hasImage =
    Array.isArray(lastUser?.content) && lastUser.content.some((p) => p.type === 'image_url');

  if (chunks.length === 0) {
    return language === 'ml'
      ? 'ഞാൻ സഹായിക്കാൻ തയ്യാറാണ്! നിങ്ങൾക്ക് ആപ്പിലെ വിവരങ്ങൾ തിരയാനോ, Excel/PDF ആയി ഡൗൺലോഡ് ചെയ്യാനോ, "Guide me" വഴി സ്റ്റെപ്പ്-ബൈ-സ്റ്റെപ്പ് സഹായം തേടാനോ കഴിയും.'
      : 'I am ready to help! Ask about records in this workspace, request an Excel/PDF/CSV export, attach a screenshot or spreadsheet, or ask for a step-by-step guide.';
  }

  const top = chunks[0];
  const citations = chunks
    .slice(0, 3)
    .map((c) => `${c.source} (${c.heading})`)
    .join(', ');

  if (hasImage) {
    return [
      `Based on the uploaded screenshot and **${top.heading}**:`,
      '',
      '1. Review the active form or table highlighted on the current screen.',
      `2. Verify required inputs match **${top.source}**.`,
      '3. Fix any highlighted validation warnings and retry the action.',
      '',
      `Source: ${citations}`,
    ].join('\n');
  }

  const combinedLines: string[] = [];
  for (const chunk of chunks.slice(0, 3)) {
    const lines = chunk.content
      .replace(/^#+\s*/gm, '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    for (const line of lines) {
      if (!combinedLines.includes(line)) combinedLines.push(line);
      if (combinedLines.length >= 24) break;
    }
    if (combinedLines.length >= 24) break;
  }

  const prefix = language === 'ml' ? 'ലഭ്യമായ വിവരങ്ങൾ പ്രകാരം:\n\n' : '';
  return `${prefix}${combinedLines.join('\n')}\n\nSource: ${citations}`;
}

function messagesContainImage(messages: LlmChatMessage[]): boolean {
  return messages.some(
    (m) =>
      Array.isArray(m.content) &&
      m.content.some((part) => part.type === 'image_url' || part.type === 'file_data')
  );
}

export function createLlmGateway(cfg: ServerConfig): LlmGateway {
  const chain = new ProviderFallbackChain(cfg);
  const hasLiveProvider = chain.getProviders().some((p) => p.isConfigured());

  return {
    hasLiveProvider,
    chain,

    async streamChat({
      model,
      messages,
      onDelta,
      onStreamReset,
      retrievedChunks = [],
      language = 'en',
      signal,
    }) {
      const hasImage = messagesContainImage(messages);
      const modelType = hasImage ? 'vision' : model === cfg.modelStrong ? 'strong' : 'fast';

      if (hasLiveProvider) {
        try {
          return await chain.streamChat(
            {
              modelType,
              messages,
              temperature: 0.2,
              maxTokens: 700,
            },
            { signal, onDelta, onStreamReset }
          );
        } catch (err) {
          logger.warn(
            { err },
            'All live providers failed in streamChat; using grounded local fallback'
          );
        }
      }

      const synthesized = buildGroundedLocalAnswer(messages, retrievedChunks, language);
      for (const token of synthesized.split(/(\s+)/)) {
        if (token) onDelta(token);
      }
      return {
        fullText: synthesized,
        modelUsed: 'local-grounded-fallback',
        provider: 'local',
        ttftMs: 10,
        totalMs: 20,
      };
    },

    async completeWithTools({
      model: _model,
      messages,
      tools,
      retrievedChunks = [],
      language = 'en',
      signal,
    }) {
      if (hasLiveProvider && tools.length > 0) {
        try {
          const needsVision = messagesContainImage(messages);
          return await chain.completeWithTools(
            {
              modelType: needsVision ? 'vision' : 'strong',
              messages,
              tools,
              temperature: 0.1,
              maxTokens: 700,
            },
            { signal }
          );
        } catch (err) {
          logger.warn(
            { err },
            'All live providers failed in completeWithTools; using grounded local fallback'
          );
        }
      }

      return {
        content: buildGroundedLocalAnswer(messages, retrievedChunks, language),
        toolCalls: [],
        modelUsed: 'local-grounded-fallback',
        provider: 'local',
      };
    },
  };
}
