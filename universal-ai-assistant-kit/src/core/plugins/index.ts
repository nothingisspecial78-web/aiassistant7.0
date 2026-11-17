import type { AssistantConfig } from '../config/schema.ts';
import type { UserContext } from '../adapters/types.ts';

export interface PluginContext {
  config: AssistantConfig;
  user?: UserContext;
  orgId?: string;
}

export interface AssistantPlugin {
  name: string;
  version?: string;
  description?: string;
  init?(ctx: PluginContext): Promise<void> | void;
  beforeModelCall?(prompt: string, ctx: PluginContext): Promise<string> | string;
  afterModelCall?(response: string, ctx: PluginContext): Promise<string> | string;
  onAudit?(event: { type: string; payload: unknown; timestamp: string }): Promise<void> | void;
}

const pluginRegistry = new Map<string, AssistantPlugin>();

export function registerPlugin(plugin: AssistantPlugin): void {
  pluginRegistry.set(plugin.name, plugin);
}

export function unregisterPlugin(name: string): void {
  pluginRegistry.delete(name);
}

export function getPlugins(): AssistantPlugin[] {
  return Array.from(pluginRegistry.values());
}

export function clearPlugins(): void {
  pluginRegistry.clear();
}
