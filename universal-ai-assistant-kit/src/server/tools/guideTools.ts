import { z } from 'zod';
import { GuideService } from '../guides/guideService.ts';
import type { AccessScope } from '../security/scope.ts';
import type { ToolDefinition, ToolExecutionContext, ToolExecutionResult } from './types.ts';

const fallbackGuideService = new GuideService();

export const SearchGuidesInputSchema = z.object({
  query: z.string().describe('Query or task to find step-by-step interactive guides for'),
});

export const StartGuideInputSchema = z.object({
  guideId: z.string().describe('Unique guide ID to start'),
  startStep: z.string().optional().describe('Optional step ID to start from'),
});

export const searchGuidesTool: ToolDefinition = {
  name: 'search_guides',
  description: 'Search authored interactive on-screen guides for the current user role.',
  risk: 'read',
  autoExecute: true,
  inputSchema: SearchGuidesInputSchema,
  jsonParameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Task or question to find a walkthrough guide for' },
    },
    required: ['query'],
  },
  summarize: (args) => `Search guides for "${String(args.query || '')}"`,
  async execute(
    args: Record<string, unknown>,
    ctx: ToolExecutionContext & { scope?: AccessScope }
  ): Promise<ToolExecutionResult> {
    const svc = ctx.guideService || fallbackGuideService;
    const q = String(args.query || '');
    const matches = svc.searchGuides(q, ctx.scope, 5);
    if (matches.length === 0) {
      return {
        ok: true,
        summary: `No interactive guide found for "${q}".`,
        data: { matches: [] },
      };
    }
    return {
      ok: true,
      summary: `Found ${matches.length} matching interactive guide(s).`,
      data: { matches },
    };
  },
};

export const startGuideTool: ToolDefinition = {
  name: 'start_guide',
  description: 'Start an interactive on-screen walkthrough guide with spotlight and voice.',
  risk: 'read',
  autoExecute: true,
  uiTrigger: true,
  inputSchema: StartGuideInputSchema,
  jsonParameters: {
    type: 'object',
    properties: {
      guideId: { type: 'string', description: 'Guide ID to launch' },
      startStep: { type: 'string', description: 'Optional initial step ID' },
    },
    required: ['guideId'],
  },
  summarize: (args) => `Start interactive guide "${String(args.guideId || '')}"`,
  async execute(
    args: Record<string, unknown>,
    ctx: ToolExecutionContext & { scope?: AccessScope }
  ): Promise<ToolExecutionResult> {
    const svc = ctx.guideService || fallbackGuideService;
    const guideId = String(args.guideId || '');
    const startStep = typeof args.startStep === 'string' ? args.startStep : undefined;
    const guide = svc.getGuideById(guideId, ctx.scope);

    if (!guide) {
      return {
        ok: false,
        summary: "This guide isn't available for your account.",
        data: { error: 'UNAUTHORIZED_OR_NOT_FOUND', guideId },
      };
    }

    svc.recordProgress({
      userId: ctx.userId || 'default-user',
      guideId,
      stepId: startStep || guide.steps[0]?.stepId || 'start',
      status: 'started',
      updatedAt: new Date().toISOString(),
    });

    return {
      ok: true,
      summary: `Starting interactive guide: ${guide.title.en}.`,
      data: {
        guideId,
        title: guide.title.en,
        startStep: startStep || guide.steps[0]?.stepId,
        stepCount: guide.steps.length,
        startRoute: guide.startRoute,
      },
      uiAction: {
        action: 'refresh',
        label: `Start guide ${guide.title.en}`,
        appCommand: {
          command: 'start_guide',
          payload: { guideId, startStep },
        },
      },
    };
  },
};

export const GUIDE_TOOLS = [searchGuidesTool, startGuideTool];
