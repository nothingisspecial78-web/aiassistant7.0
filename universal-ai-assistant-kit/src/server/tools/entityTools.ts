import { z } from 'zod';
import {
  getEntityDetails,
  getRegisteredEntityConfig,
  searchEntities,
} from '../entityRegistry/searchEngine.ts';
import { appInternalFetch, resolveAppBaseUrl } from '../auth.ts';
import type { ToolDefinition, ToolExecutionContext } from './types.ts';

type CollectionRecord = Record<string, unknown>;
type CollectionMap = Record<string, CollectionRecord[]>;

export async function resolveCollectionsForApp(
  ctx: ToolExecutionContext
): Promise<CollectionMap> {
  const config = getRegisteredEntityConfig(ctx.appId);
  const merged: CollectionMap = {};

  const appendRecords = (
    collectionKey: string,
    records: CollectionRecord[],
    idField = 'id'
  ) => {
    const bucket = (merged[collectionKey] ||= []);
    const seenIds = new Set(
      bucket
        .map((r) => String(r[idField] ?? '').trim().toLowerCase())
        .filter(Boolean)
    );
    for (const rec of records) {
      const id = String(rec[idField] ?? '').trim().toLowerCase();
      if (id && seenIds.has(id)) continue;
      if (id) seenIds.add(id);
      bucket.push(rec);
    }
  };

  // 1. Live appState collections / arrays passed by frontend
  const appState = ctx.appState || {};
  const explicitCollections =
    appState.collections && typeof appState.collections === 'object'
      ? (appState.collections as Record<string, unknown>)
      : {};

  for (const [k, val] of Object.entries(explicitCollections)) {
    if (Array.isArray(val)) {
      appendRecords(k, val as CollectionRecord[]);
    }
  }

  for (const entityDef of config.entities) {
    const colKey = entityDef.collection;
    const fromTopLevel = appState[colKey];
    if (Array.isArray(fromTopLevel)) {
      appendRecords(colKey, fromTopLevel as CollectionRecord[], entityDef.idField);
    }
  }

  // Also index arbitrary top-level arrays in appState (e.g. `appState.orders`, `appState.rows`)
  for (const [k, val] of Object.entries(appState)) {
    if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object' && val[0] !== null) {
      appendRecords(k, val as CollectionRecord[]);
    }
  }

  // 2. Host programmatic resolveData callback (e.g. database adapter or app repository)
  if (ctx.resolveData) {
    try {
      const hostData = await ctx.resolveData({
        appId: ctx.appId,
        scope: ctx.scope,
        appState: ctx.appState,
      });
      if (hostData && typeof hostData === 'object') {
        for (const [colKey, rows] of Object.entries(hostData)) {
          if (Array.isArray(rows)) {
            appendRecords(colKey, rows as CollectionRecord[]);
          }
        }
      }
    } catch {
      // ignore host resolver failures gracefully
    }
  }

  // 3. Host DataAdapter (e.g. MemoryDataAdapter, SupabaseDataAdapter, SQLDataAdapter)
  if (ctx.dataAdapter) {
    for (const entityDef of config.entities) {
      if ((merged[entityDef.collection] || []).length > 0) continue;
      try {
        const rows = await ctx.dataAdapter.list(entityDef.collection);
        if (Array.isArray(rows) && rows.length > 0) {
          appendRecords(
            entityDef.collection,
            rows as CollectionRecord[],
            entityDef.idField
          );
        }
      } catch {
        // adapter optional per collection
      }
    }
  }

  // 4. Optional REST API hydration via profile.api.baseUrl
  if (ctx.profile?.api?.baseUrl) {
    await Promise.all(
      config.entities.map(async (entityDef) => {
        if ((merged[entityDef.collection] || []).length > 0) return;
        try {
          const base = resolveAppBaseUrl(
            ctx.profile.api.baseUrl,
            ctx.cfg.port,
            ctx.appId
          ).replace(/\/$/, '');
          const endpoint = new URL(entityDef.collection, `${base}/`);
          const res = await appInternalFetch(endpoint, {
            method: 'GET',
            headers: {
              'x-app-id': ctx.appId,
              ...(ctx.authToken ? { Authorization: `Bearer ${ctx.authToken}` } : {}),
            },
          });
          if (!res.ok) return;
          const json = (await res.json()) as Record<string, unknown>;
          const list = Array.isArray(json[entityDef.collection])
            ? (json[entityDef.collection] as CollectionRecord[])
            : Array.isArray(json.items)
              ? (json.items as CollectionRecord[])
              : [];
          if (list.length > 0) {
            appendRecords(entityDef.collection, list, entityDef.idField);
          }
        } catch {
          // optional endpoint not present
        }
      })
    );
  }

  return merged;
}

export const searchEntitiesTool: ToolDefinition = {
  name: 'search_entities',
  description:
    'Search across all registered live entity types in this app in parallel using case-insensitive, partial, phonetic, and fuzzy matching.',
  risk: 'read',
  inputSchema: z.object({
    query: z.string().min(1).describe('Name, title, ID, phone, email, or keyword'),
    types: z.array(z.string()).optional().describe('Optional filter of entity type names'),
  }),
  jsonParameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Name, ID, title, phone, email, or keyword' },
      types: { type: 'array', items: { type: 'string' }, description: 'Optional entity type filter' },
    },
    required: ['query'],
  },
  summarize: (args) => `Search live app entities matching "${String(args.query || '')}"`,
  async execute(args, ctx) {
    const config = getRegisteredEntityConfig(ctx.appId);
    const collections = await resolveCollectionsForApp(ctx);
    const result = await searchEntities({
      config,
      collections,
      query: String(args.query || ''),
      types: Array.isArray(args.types) ? args.types.map(String) : undefined,
      scope: ctx.scope,
    });

    return {
      ok: result.ok,
      summary: result.summary,
      data: result,
    };
  },
};

export const getEntityDetailsTool: ToolDefinition = {
  name: 'get_entity_details',
  description: 'Fetch complete live record details for a specific entity by type and id.',
  risk: 'read',
  inputSchema: z.object({
    type: z.string().min(1),
    id: z.string().min(1),
  }),
  jsonParameters: {
    type: 'object',
    properties: {
      type: { type: 'string', description: 'Entity type name' },
      id: { type: 'string', description: 'Entity unique ID' },
    },
    required: ['type', 'id'],
  },
  summarize: (args) => `Get details for ${String(args.type || 'entity')} ${String(args.id || '')}`,
  async execute(args, ctx) {
    const config = getRegisteredEntityConfig(ctx.appId);
    const collections = await resolveCollectionsForApp(ctx);
    const result = await getEntityDetails({
      config,
      collections,
      type: String(args.type || ''),
      id: String(args.id || ''),
      scope: ctx.scope,
    });

    return {
      ok: result.ok,
      summary: result.summary,
      data: result,
    };
  },
};

export const ENTITY_TOOLS: Record<string, ToolDefinition> = {
  search_entities: searchEntitiesTool,
  get_entity_details: getEntityDetailsTool,
};
