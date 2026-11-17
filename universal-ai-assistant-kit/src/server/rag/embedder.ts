import { GoogleGenAI } from '@google/genai';
import { logger, type ServerConfig } from '../config.ts';

const HASH_DIM = 384;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

function hashToken(token: string): number {
  let h = 2166136261;
  for (let i = 0; i < token.length; i += 1) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

export function deterministicLocalEmbed(text: string): number[] {
  const vec = new Array<number>(HASH_DIM).fill(0);
  const tokens = tokenize(text);
  if (tokens.length === 0) return vec;

  for (const tok of tokens) {
    const idx = hashToken(tok) % HASH_DIM;
    vec[idx] += 1;
    if (tok.length >= 4) {
      for (let i = 0; i <= tok.length - 3; i += 1) {
        const tri = tok.slice(i, i + 3);
        vec[hashToken(tri) % HASH_DIM] += 0.35;
      }
    }
  }

  let norm = 0;
  for (const v of vec) norm += v * v;
  const denom = Math.sqrt(norm) || 1;
  return vec.map((v) => v / denom);
}

export class Embedder {
  readonly isRemoteEnabled: boolean;
  private readonly geminiClient?: GoogleGenAI;

  constructor(private readonly cfg: ServerConfig) {
    this.isRemoteEnabled = Boolean(cfg.geminiApiKey || cfg.openRouterApiKey);
    if (cfg.geminiApiKey) {
      this.geminiClient = new GoogleGenAI({ apiKey: cfg.geminiApiKey });
    }
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    if (this.geminiClient) {
      try {
        const vectors: number[][] = [];
        for (const text of texts) {
          const res = await this.geminiClient.models.embedContent({
            model: this.cfg.geminiEmbedModel,
            contents: text,
          });
          const vals = res.embeddings?.[0]?.values;
          if (vals && vals.length > 0) {
            vectors.push(vals);
          } else {
            throw new Error('Gemini returned empty embedding vector');
          }
        }
        return vectors;
      } catch (err) {
        logger.debug({ err }, 'Gemini embedding failed; falling back');
      }
    }

    if (this.cfg.openRouterApiKey) {
      try {
        const res = await fetch(`${this.cfg.openRouterBaseUrl}/embeddings`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.cfg.openRouterApiKey}`,
          },
          body: JSON.stringify({
            model: this.cfg.modelEmbed,
            input: texts,
          }),
        });
        if (res.ok) {
          const data = (await res.json()) as {
            data?: Array<{ embedding: number[]; index: number }>;
          };
          if (Array.isArray(data.data) && data.data.length === texts.length) {
            return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
          }
        }
      } catch (err) {
        logger.debug({ err }, 'OpenRouter embedding failed; using deterministic local embed');
      }
    }

    return texts.map((t) => deterministicLocalEmbed(t));
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vec] = await this.embedBatch([text]);
    return vec || deterministicLocalEmbed(text);
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export function keywordOverlapScore(query: string, content: string): number {
  const qTokens = new Set(tokenize(query));
  if (qTokens.size === 0) return 0;
  const docTokens = new Set(tokenize(content));
  let hits = 0;
  for (const qt of qTokens) {
    if (docTokens.has(qt)) {
      hits += 1;
      continue;
    }
    for (const dt of docTokens) {
      if (dt.includes(qt) || qt.includes(dt)) {
        hits += 0.65;
        break;
      }
    }
  }
  return Math.min(1, hits / Math.max(1, qTokens.size));
}
