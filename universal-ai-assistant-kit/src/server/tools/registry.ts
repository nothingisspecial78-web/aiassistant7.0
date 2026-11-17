import { z } from 'zod';
import {
  type AppProfile,
  type DeclarativeToolDefinition,
} from '../../core/index.ts';
import { appInternalFetch, resolveAppBaseUrl } from '../auth.ts';
import type { AccessScope } from '../security/scope.ts';
import { ENTITY_TOOLS } from './entityTools.ts';
import { EXPORT_TOOLS } from './exportTools.ts';
import { GUIDE_TOOLS } from './guideTools.ts';
import { QUERY_TOOLS } from './queryTools.ts';
import type { ToolDefinition, ToolExecutionContext, ToolExecutionResult } from './types.ts';

async function callConnectedAppApi(
  ctx: ToolExecutionContext,
  path: string,
  method: string,
  body?: unknown
): Promise<{ status: number; data: Record<string, unknown> }> {
  const base = resolveAppBaseUrl(ctx.profile.api.baseUrl, ctx.cfg.port, ctx.appId).replace(
    /\/$/,
    ''
  );
  const relativePath = path.replace(/^\/+/, '');
  const targetUrl = new URL(relativePath, `${base}/`);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-app-id': ctx.appId,
  };
  if (ctx.authToken) {
    headers.Authorization = `Bearer ${ctx.authToken}`;
  }

  const res = await appInternalFetch(targetUrl, {
    method,
    headers,
    body: body !== undefined && method !== 'GET' ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    parsed = { raw: text };
  }

  if (!res.ok) {
    const errMsg =
      typeof parsed.error === 'string' ? parsed.error : `App API returned HTTP ${res.status}`;
    throw new Error(errMsg);
  }
  return { status: res.status, data: parsed };
}

export const controlAppUiTool: ToolDefinition = {
  name: 'controlAppUi',
  description:
    'Navigate views/tabs/routes or apply search and filter controls directly in the live web application UI.',
  risk: 'read',
  uiTrigger: true,
  inputSchema: z.object({
    tab: z.string().optional(),
    route: z.string().optional(),
    searchQuery: z.string().optional(),
    filterKey: z.string().optional(),
    filterValue: z.string().optional(),
    selector: z.string().optional(),
  }),
  jsonParameters: {
    type: 'object',
    properties: {
      tab: { type: 'string', description: 'Target tab or section identifier' },
      route: { type: 'string', description: 'Optional route path to navigate to (e.g. /orders)' },
      searchQuery: { type: 'string', description: 'Search text to apply or "" to clear' },
      filterKey: { type: 'string', description: 'Optional filter control identifier' },
      filterValue: { type: 'string', description: 'Optional filter value' },
      selector: { type: 'string', description: 'Optional explicit CSS selector to click' },
    },
  },
  summarize: (args) => {
    const parts: string[] = [];
    if (args.route) parts.push(`navigate to ${String(args.route)}`);
    if (args.tab) parts.push(`open ${String(args.tab)}`);
    if (typeof args.searchQuery === 'string') {
      parts.push(args.searchQuery ? `search "${args.searchQuery}"` : 'clear search');
    }
    if (typeof args.filterValue === 'string') {
      parts.push(args.filterValue ? `filter by ${args.filterValue}` : 'clear filter');
    }
    return `Update UI: ${parts.join(', ') || 'navigate'}`;
  },
  async execute(args) {
    const tab =
      typeof args.tab === 'string' && args.tab.trim() ? args.tab.trim().toLowerCase() : undefined;
    const route =
      typeof args.route === 'string' && args.route.trim() ? args.route.trim() : undefined;
    const followUps: Array<{ action: 'click' | 'set_value'; selector: string; value?: string }> = [];

    if (typeof args.searchQuery === 'string') {
      followUps.push({
        action: 'set_value',
        selector: '[data-uai-control="search"], [data-aia-control="search"]',
        value: args.searchQuery,
      });
    }
    if (typeof args.filterValue === 'string') {
      const fKey = typeof args.filterKey === 'string' && args.filterKey ? args.filterKey : 'filter';
      followUps.push({
        action: 'set_value',
        selector: `[data-uai-control="${fKey}"], [data-aia-control="${fKey}"]`,
        value: args.filterValue,
      });
    }

    const explicitSelector =
      typeof args.selector === 'string' && args.selector.trim() ? args.selector.trim() : undefined;
    const tabSelector = tab
      ? `[data-uai-tab="${tab}"], [data-aia-tab="${tab}"], [data-uai-id="${tab}"]`
      : undefined;
    const primarySelector = explicitSelector || tabSelector || followUps[0]?.selector;
    const primaryAction =
      explicitSelector || tabSelector ? 'click' : followUps.length > 0 ? 'set_value' : 'click';
    const primaryValue = explicitSelector || tabSelector ? undefined : followUps[0]?.value;
    const remaining = explicitSelector || tabSelector ? followUps : followUps.slice(1);

    const summaryParts: string[] = [];
    if (route) summaryParts.push(`navigated to **${route}**`);
    if (tab) summaryParts.push(`switched to **${tab}**`);
    if (typeof args.searchQuery === 'string') {
      summaryParts.push(args.searchQuery ? `searched for **${args.searchQuery}**` : 'cleared search');
    }
    if (typeof args.filterValue === 'string') {
      summaryParts.push(
        args.filterValue ? `filtered by **${args.filterValue}**` : 'cleared filter'
      );
    }

    return {
      ok: true,
      summary: `Done — ${summaryParts.join(' and ') || 'updated the view'}.`,
      data: { tab, route, searchQuery: args.searchQuery, filterValue: args.filterValue },
      uiAction: {
        action: primaryAction,
        selector: primarySelector,
        fallbackTabSelector: tabSelector,
        value: primaryValue,
        followUpActions: remaining.length > 0 ? remaining : undefined,
        ...(route
          ? {
              appCommand: {
                command: 'navigate',
                payload: { route },
              },
            }
          : {}),
        label: summaryParts.join(', ') || 'Updated UI',
      },
    };
  },
};

export function compileDeclarativeTool(def: DeclarativeToolDefinition): ToolDefinition {
  const zodShape: Record<string, z.ZodTypeAny> = {};
  const jsonProps: Record<string, unknown> = {};
  const requiredFields: string[] = [];

  for (const [key, prop] of Object.entries(def.parameters)) {
    let zProp: z.ZodTypeAny;
    if (prop.type === 'number') {
      zProp = z.coerce.number();
    } else if (prop.type === 'boolean') {
      zProp = z.boolean();
    } else if (prop.type === 'array') {
      zProp = z.array(z.unknown());
    } else {
      zProp =
        prop.enum && prop.enum.length > 0
          ? z.enum(prop.enum as [string, ...string[]])
          : z.string();
    }
    zodShape[key] = prop.required ? zProp : zProp.optional();
    if (prop.required) requiredFields.push(key);
    jsonProps[key] = {
      type: prop.type,
      description: prop.description,
      ...(prop.enum ? { enum: prop.enum } : {}),
    };
  }

  return {
    name: def.name,
    description: def.description,
    risk: def.risk,
    autoExecute: def.autoExecute,
    inputSchema: z.object(zodShape),
    jsonParameters: {
      type: 'object',
      properties: jsonProps,
      ...(requiredFields.length > 0 ? { required: requiredFields } : {}),
    },
    summarize: (args) => {
      if (!def.summaryTemplate) {
        return `Execute ${def.name} with ${JSON.stringify(args)}`;
      }
      return def.summaryTemplate.replace(/\{(\w+)\}/g, (_, k) => String(args[k] ?? ''));
    },
    async execute(args, ctx): Promise<ToolExecutionResult> {
      let targetPath = def.path;
      let body: unknown = args;
      if (def.method === 'GET') {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(args)) {
          if (v !== undefined && v !== null && String(v).length > 0) {
            qs.set(k, String(v));
          }
        }
        const qStr = qs.toString();
        if (qStr) targetPath += (targetPath.includes('?') ? '&' : '?') + qStr;
        body = undefined;
      }

      const { data } = await callConnectedAppApi(ctx, targetPath, def.method, body);
      const createdId =
        typeof data.id === 'string'
          ? [data.id]
          : Array.isArray(data.createdIds)
            ? data.createdIds.map(String)
            : data.record && typeof (data.record as Record<string, unknown>).id === 'string'
              ? [String((data.record as Record<string, unknown>).id)]
              : [];

      return {
        ok: true,
        summary: `Executed ${def.name} successfully.`,
        data,
        createdIds: createdId,
        uiAction:
          def.risk === 'write'
            ? {
                action: 'refresh',
                fallbackTabSelector: def.tabSelector,
                highlightSelector: createdId[0]
                  ? `[data-uai-row="${createdId[0]}"], [data-aia-row="${createdId[0]}"]`
                  : undefined,
                refreshApp: true,
                label: def.name,
              }
            : undefined,
      };
    },
    undo: def.undoPath
      ? async (createdIds, _args, ctx) => {
          const { data } = await callConnectedAppApi(ctx, def.undoPath!, 'POST', {
            ids: createdIds,
          });
          return {
            ok: true,
            summary: `Rolled back ${def.name} (${createdIds.length} record(s)).`,
            data,
          };
        }
      : undefined,
  };
}

export const BUILTIN_TOOLS: Record<string, ToolDefinition> = {
  ...ENTITY_TOOLS,
  ...QUERY_TOOLS,
  ...EXPORT_TOOLS,
  ...Object.fromEntries(GUIDE_TOOLS.map((t) => [t.name, t])),
  controlAppUi: controlAppUiTool,
};

const PUBLIC_ALLOWED_TOOLS = new Set(['search_guides', 'start_guide']);

export class ToolRegistry {
  private readonly customTools = new Map<string, ToolDefinition>();

  constructor(initialTools: ToolDefinition[] = []) {
    for (const tool of initialTools) {
      this.customTools.set(tool.name, tool);
    }
  }

  registerTool(tool: ToolDefinition): void {
    this.customTools.set(tool.name, tool);
  }

  registerTools(tools: ToolDefinition[]): void {
    for (const tool of tools) {
      this.customTools.set(tool.name, tool);
    }
  }

  getToolsForProfile(profile: AppProfile, scope?: AccessScope): Map<string, ToolDefinition> {
    const map = new Map<string, ToolDefinition>();

    for (const def of profile.customTools || []) {
      map.set(def.name, compileDeclarativeTool(def));
    }

    const profileToolNames =
      profile.tools && profile.tools.length > 0
        ? profile.tools
        : Object.keys(BUILTIN_TOOLS);

    for (const toolName of profileToolNames) {
      const custom = this.customTools.get(toolName);
      if (custom) {
        map.set(toolName, custom);
        continue;
      }
      const builtin = BUILTIN_TOOLS[toolName];
      if (builtin && !map.has(toolName)) {
        map.set(toolName, builtin);
      }
    }

    for (const [name, custom] of this.customTools.entries()) {
      if (!map.has(name)) {
        map.set(name, custom);
      }
    }

    if (scope && scope.role === 'PUBLIC') {
      for (const name of Array.from(map.keys())) {
        if (!PUBLIC_ALLOWED_TOOLS.has(name)) {
          map.delete(name);
        }
      }
    }

    return map;
  }

  getTool(profile: AppProfile, toolName: string, scope?: AccessScope): ToolDefinition | undefined {
    return this.getToolsForProfile(profile, scope).get(toolName);
  }
}
