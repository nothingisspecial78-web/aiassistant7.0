import type { AppProfile, RightClickContext, SourceCitation } from '../../core/index.ts';
import type { ProfileRegistry } from '../profiles/loader.ts';
import type { AccessScope } from '../security/scope.ts';
import { chunkMarkdownDocument } from './chunker.ts';
import type { Embedder } from './embedder.ts';
import type { RetrievedChunk, VectorStore } from './store.ts';

export async function ingestAppDocs(params: {
  appId: string;
  profiles: ProfileRegistry;
  embedder: Embedder;
  store: VectorStore;
}): Promise<{ appId: string; chunkCount: number }> {
  const docs = params.profiles.getDocs(params.appId);
  const rawChunks = docs.flatMap((d) => chunkMarkdownDocument(d.source, d.content));
  const embeddings = await params.embedder.embedBatch(
    rawChunks.map((c) => `${c.heading}\n${c.content}`)
  );

  const stored = rawChunks.map((c, idx) => ({
    id: `${params.appId}:${c.source}:${c.chunkIndex}`,
    appId: params.appId,
    source: c.source,
    heading: c.heading,
    chunkIndex: c.chunkIndex,
    content: c.content,
    embedding: embeddings[idx] || [],
  }));

  await params.store.replaceAppChunks(params.appId, stored);
  return { appId: params.appId, chunkCount: stored.length };
}

export async function ingestAllProfiles(params: {
  profiles: ProfileRegistry;
  embedder: Embedder;
  store: VectorStore;
}): Promise<Array<{ appId: string; chunkCount: number }>> {
  const results: Array<{ appId: string; chunkCount: number }> = [];
  for (const profile of params.profiles.listProfiles()) {
    results.push(
      await ingestAppDocs({
        appId: profile.appId,
        profiles: params.profiles,
        embedder: params.embedder,
        store: params.store,
      })
    );
  }
  return results;
}

export async function retrieveForQuery(params: {
  profile: AppProfile;
  question: string;
  context?: RightClickContext;
  contexts?: RightClickContext[];
  embedder: Embedder;
  store: VectorStore;
  minSimilarity?: number;
  bypassOutOfScopeGuard?: boolean;
  scope?: AccessScope;
}): Promise<{
  refused: boolean;
  refusalMessage?: string;
  topScore: number;
  chunks: RetrievedChunk[];
  citations: SourceCitation[];
}> {
  // If no documents have been indexed for this app, never block with out-of-scope refusal
  if (!params.store.hasChunks(params.profile.appId)) {
    return {
      refused: false,
      topScore: 1,
      chunks: [],
      citations: [],
    };
  }

  const extraCtx = (params.contexts && params.contexts.length > 0
    ? params.contexts
    : params.context
      ? [params.context]
      : []
  )
    .map((c) => `${c.nearbyLabel || ''} ${c.text || ''}`.trim())
    .filter(Boolean)
    .join(' ');

  const enrichedQuery = [params.question, extraCtx].filter(Boolean).join(' ');
  const queryVec = await params.embedder.embedQuery(enrichedQuery);
  const chunks = await params.store.search({
    appId: params.profile.appId,
    queryText: enrichedQuery,
    queryEmbedding: queryVec,
    topK: 5,
  });

  const topScore = chunks[0]?.score ?? 0;
  const threshold = params.minSimilarity ?? 0.12;
  const isGreeting = /^(hi|hello|hey|help|what can you do|thanks|thank you|നമസ്കാരം|ഹായ്)[!?. ]*$/i.test(
    params.question.trim()
  );

  if (!params.bypassOutOfScopeGuard && !isGreeting && chunks.length > 0 && topScore < threshold) {
    return {
      refused: true,
      refusalMessage: params.profile.refusalMessage,
      topScore,
      chunks: [],
      citations: [],
    };
  }

  const citations: SourceCitation[] = chunks
    .filter((c) => c.score >= threshold)
    .slice(0, 3)
    .map((c) => ({
      source: c.source,
      heading: c.heading,
      score: c.score,
    }));

  return {
    refused: false,
    topScore,
    chunks,
    citations,
  };
}
