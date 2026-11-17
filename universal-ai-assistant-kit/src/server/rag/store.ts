import { logger, type ServerConfig } from '../config.ts';
import { cosineSimilarity, keywordOverlapScore } from './embedder.ts';

export interface StoredChunk {
  id: string;
  appId: string;
  source: string;
  heading: string;
  chunkIndex: number;
  content: string;
  embedding: number[];
}

export interface RetrievedChunk extends StoredChunk {
  score: number;
}

export class VectorStore {
  private readonly memoryByApp = new Map<string, StoredChunk[]>();
  private supabaseClient: unknown | null = null;
  private supabaseInitAttempted = false;

  constructor(private readonly cfg: ServerConfig) {}

  private async getSupabase(): Promise<{
    from: (t: string) => { delete: () => { eq: (col: string, v: string) => Promise<unknown> }; insert: (rows: unknown[]) => Promise<{ error?: { message: string } }> };
    rpc: (fn: string, args: unknown) => Promise<{ data?: Array<Record<string, unknown>>; error?: { message: string } }>;
  } | null> {
    if (!this.cfg.supabaseUrl || !this.cfg.supabaseServiceRoleKey) return null;
    if (!this.supabaseInitAttempted) {
      this.supabaseInitAttempted = true;
      try {
        const mod = (await import('@supabase/supabase-js').catch(() => null)) as {
          createClient?: (u: string, k: string) => unknown;
        } | null;
        if (mod?.createClient) {
          this.supabaseClient = mod.createClient(
            this.cfg.supabaseUrl,
            this.cfg.supabaseServiceRoleKey
          );
        }
      } catch {
        this.supabaseClient = null;
      }
    }
    return this.supabaseClient as ReturnType<VectorStore['getSupabase']> extends Promise<infer R> ? R : null;
  }

  get mode(): 'supabase-pgvector' | 'memory' {
    return this.cfg.supabaseUrl && this.cfg.supabaseServiceRoleKey
      ? 'supabase-pgvector'
      : 'memory';
  }

  async replaceAppChunks(appId: string, chunks: StoredChunk[]): Promise<void> {
    this.memoryByApp.set(appId, chunks);

    const client = await this.getSupabase();
    if (!client) return;

    try {
      await client.from('ai_doc_chunks').delete().eq('app_id', appId);
      if (chunks.length > 0) {
        const rows = chunks.map((c) => ({
          id: c.id,
          app_id: c.appId,
          source: c.source,
          heading: c.heading,
          chunk_index: c.chunkIndex,
          content: c.content,
          embedding: c.embedding,
        }));
        const { error } = await client.from('ai_doc_chunks').insert(rows);
        if (error) {
          logger.warn({ error: error.message }, 'Supabase chunk insert failed; memory store active');
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Supabase replaceAppChunks error; using memory store');
    }
  }

  hasChunks(appId: string): boolean {
    return (this.memoryByApp.get(appId)?.length || 0) > 0;
  }

  async search(params: {
    appId: string;
    queryText: string;
    queryEmbedding: number[];
    topK?: number;
  }): Promise<RetrievedChunk[]> {
    const topK = params.topK ?? 6;
    const client = await this.getSupabase();

    if (client) {
      try {
        const { data, error } = await client.rpc('match_ai_doc_chunks', {
          filter_app_id: params.appId,
          query_embedding: params.queryEmbedding,
          match_count: topK,
        });
        if (!error && Array.isArray(data) && data.length > 0) {
          return data.map((row) => ({
            id: String(row.id),
            appId: String(row.app_id),
            source: String(row.source),
            heading: String(row.heading || ''),
            chunkIndex: Number(row.chunk_index || 0),
            content: String(row.content || ''),
            embedding: [],
            score: Number(row.similarity || 0),
          }));
        }
      } catch {
        // Fallback to in-memory
      }
    }

    const candidates = this.memoryByApp.get(params.appId) || [];
    return candidates
      .map((chunk) => {
        const vecSim = cosineSimilarity(params.queryEmbedding, chunk.embedding);
        const kwSim = keywordOverlapScore(params.queryText, `${chunk.heading} ${chunk.content}`);
        const hybrid = Math.max(vecSim, 0.55 * vecSim + 0.65 * kwSim);
        return {
          ...chunk,
          score: Number(hybrid.toFixed(4)),
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}
