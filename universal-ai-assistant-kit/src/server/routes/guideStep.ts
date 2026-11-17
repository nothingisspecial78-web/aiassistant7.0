import { GoogleGenAI } from '@google/genai';
import { Router, type Request, type Response } from 'express';
import {
  buildDeterministicGuideStep,
  detectAmbiguousGuidePaths,
  estimateRequiredGuideSteps,
  GUIDE_SYSTEM_PROMPT,
  GuideStepRequestSchema,
  MAX_GUIDE_STEPS,
  OPENROUTER_GUIDE_MODELS,
  resolveGuideTroubleshootingStep,
  sanitizeGuideStepDecision,
  type AvailableRouteHint,
  type GuideStepResponse,
  type GuideTroubleshootingContext,
  type PageMapElement,
} from '../../core/index.ts';
import { checkAndConsumeAiCredit } from '../billing/checkAndConsume.ts';
import type { OrgCreditStore } from '../billing/creditStore.ts';
import { logger, type ServerConfig } from '../config.ts';
import { isPublicAuthContext, isPublicGuideGoalAllowed } from '../llm/publicGuard.ts';
import { extractAccessScope } from '../security/scope.ts';

export interface GuideStepRouteDeps {
  cfg: ServerConfig;
  creditStore?: OrgCreditStore;
  fetchImpl?: typeof fetch;
}

export function parseGuideJsonResponse(rawText: string): Record<string, unknown> | null {
  const trimmed = rawText.trim();
  if (!trimmed) return null;

  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    const parsed = JSON.parse(withoutFence);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    const firstBrace = withoutFence.indexOf('{');
    const lastBrace = withoutFence.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        const sliced = JSON.parse(withoutFence.slice(firstBrace, lastBrace + 1));
        return sliced && typeof sliced === 'object' && !Array.isArray(sliced)
          ? (sliced as Record<string, unknown>)
          : null;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function buildCompactGuideUserJson(params: {
  goal: string;
  previousStepSummary: string;
  currentRoute: string;
  stepNumber: number;
  pageMap: PageMapElement[];
  confirmedPath?: boolean;
  preferredTargetId?: string;
  preferredRoute?: string;
  availableRoutes?: AvailableRouteHint[];
  appContext?: string;
}): string {
  const userPayload: Record<string, unknown> = {
    goal: params.goal,
    route: params.currentRoute,
    step: params.stepNumber,
    prev:
      params.previousStepSummary.length > 380
        ? params.previousStepSummary.slice(-380)
        : params.previousStepSummary,
    pageMap: params.pageMap.slice(0, 60).map((el) => ({
      id: el.id,
      tag: el.tag,
      type: el.type,
      label: el.label,
      hasValue: el.hasValue,
      ...(el.sensitive ? { sensitive: true } : {}),
    })),
  };

  if (typeof params.confirmedPath === 'boolean') userPayload.confirmedPath = params.confirmedPath;
  if (params.preferredTargetId) userPayload.preferredTargetId = params.preferredTargetId;
  if (params.preferredRoute) userPayload.preferredRoute = params.preferredRoute;
  if (params.availableRoutes?.length) userPayload.routes = params.availableRoutes.slice(0, 25);
  if (params.appContext) userPayload.ctx = params.appContext.slice(0, 240);

  return JSON.stringify(userPayload);
}

export async function resolveGuideStepDecision(params: {
  goal: string;
  previousStepSummary: string;
  currentRoute: string;
  stepNumber: number;
  pageMap: PageMapElement[];
  confirmedPath?: boolean;
  preferredTargetId?: string;
  preferredRoute?: string;
  availableRoutes?: AvailableRouteHint[];
  appContext?: string;
  pageErrors?: string[];
  userReply?: string;
  troubleshootingContext?: GuideTroubleshootingContext;
  openRouterApiKey?: string;
  geminiApiKey?: string;
  groqApiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<GuideStepResponse> {
  const {
    goal: rawGoal,
    previousStepSummary: rawPrev,
    currentRoute,
    stepNumber: rawStepNumber,
    pageMap,
    confirmedPath: rawConfirmedPath = false,
    preferredTargetId,
    preferredRoute,
    availableRoutes = [],
    appContext,
    pageErrors = [],
    userReply,
    troubleshootingContext,
    openRouterApiKey = '',
    geminiApiKey = '',
    groqApiKey = '',
    timeoutMs = 12000,
    fetchImpl = fetch,
  } = params;

  const troubleshootingDecision = resolveGuideTroubleshootingStep({
    goal: rawGoal,
    currentRoute,
    pageErrors,
    userReply,
    troubleshootingContext,
  });
  if (troubleshootingDecision) {
    return {
      ...troubleshootingDecision,
      totalSteps: Math.max(1, Math.min(MAX_GUIDE_STEPS, rawStepNumber)),
      provider: 'guide-troubleshooting',
    };
  }

  const switchingToNewGuide =
    troubleshootingContext?.stage === 'follow_up_guide' && Boolean(userReply?.trim());
  const goal = switchingToNewGuide ? userReply!.trim() : rawGoal;
  const previousStepSummary = switchingToNewGuide ? '' : rawPrev;
  const stepNumber = switchingToNewGuide ? 1 : rawStepNumber;
  const confirmedPath = switchingToNewGuide ? false : rawConfirmedPath;

  if (stepNumber > MAX_GUIDE_STEPS) {
    return {
      ...sanitizeGuideStepDecision({ action: 'complete' }, pageMap, stepNumber),
      totalSteps: MAX_GUIDE_STEPS,
    };
  }

  const allowClarify = stepNumber === 1 && !confirmedPath;
  const localClarify = allowClarify
    ? detectAmbiguousGuidePaths({
        goal,
        pageMap,
        currentRoute,
        availableRoutes,
        appContext,
        confirmedPath,
        stepNumber,
      })
    : null;

  const lowerGoal = goal.toLowerCase();
  const wantsDemo = /\b(demo|sample|preview|trial)\b/i.test(lowerGoal);
  const wantsLogout = /\b(log\s*out|logout|sign\s*out|signout)\b/i.test(lowerGoal);

  if (allowClarify && localClarify && (wantsDemo || wantsLogout)) {
    return { ...localClarify, provider: 'deterministic-dom-clarify' };
  }

  if (stepNumber >= 2) {
    const fastCandidate = buildDeterministicGuideStep({
      goal,
      previousStepSummary,
      pageMap,
      stepNumber,
      currentRoute,
      confirmedPath,
      preferredTargetId,
      preferredRoute,
      availableRoutes,
    });
    const targetEl = fastCandidate.targetId
      ? pageMap.find((el) => el.id === fastCandidate.targetId)
      : undefined;
    const isInputOrSubmit =
      fastCandidate.action === 'point_and_wait' &&
      targetEl &&
      (['input', 'select', 'textarea'].includes(targetEl.tag) ||
        /(submit|save|create|confirm|pay|post|import)/i.test(`${targetEl.id} ${targetEl.label}`));
    if (fastCandidate.action === 'complete' || isInputOrSubmit) {
      return { ...fastCandidate, provider: 'deterministic-fast-path' };
    }
  }

  if (
    stepNumber === 1 &&
    confirmedPath &&
    preferredTargetId &&
    pageMap.some((el) => el.id === preferredTargetId)
  ) {
    return {
      ...buildDeterministicGuideStep({
        goal,
        previousStepSummary,
        pageMap,
        stepNumber,
        currentRoute,
        confirmedPath,
        preferredTargetId,
        preferredRoute,
        availableRoutes,
      }),
      provider: 'confirmed-target',
    };
  }

  const finalizeParsedDecision = (
    parsed: Record<string, unknown>,
    providerName: string
  ): GuideStepResponse => {
    const safe = sanitizeGuideStepDecision(parsed, pageMap, stepNumber, {
      allowClarify,
      availableRoutes,
      currentRoute,
    });
    if (allowClarify && localClarify && safe.action !== 'clarify') {
      return { ...localClarify, provider: providerName };
    }
    return {
      ...safe,
      totalSteps: estimateRequiredGuideSteps({
        goal,
        currentRoute,
        stepNumber,
        pageMap,
        decision: safe,
        previousStepSummary,
        llmTotalSteps: safe.totalSteps,
      }),
      provider: providerName,
    };
  };

  const guideLlmTimeoutMs = Math.max(800, Math.min(timeoutMs, 3500));
  const userJson = buildCompactGuideUserJson({
    goal,
    previousStepSummary,
    currentRoute,
    stepNumber,
    pageMap,
    confirmedPath,
    preferredTargetId,
    preferredRoute,
    availableRoutes,
    appContext,
  });

  if (openRouterApiKey) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), guideLlmTimeoutMs);
    try {
      const res = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${openRouterApiKey}`,
          'X-Title': 'Universal Guide Co-Browser',
        },
        body: JSON.stringify({
          models: [...OPENROUTER_GUIDE_MODELS],
          route: 'fallback',
          response_format: { type: 'json_object' },
          temperature: 0.1,
          max_tokens: allowClarify ? 360 : 180,
          messages: [
            { role: 'system', content: GUIDE_SYSTEM_PROMPT },
            { role: 'user', content: userJson },
          ],
        }),
        signal: controller.signal,
      });
      if (res.ok) {
        const data = (await res.json()) as {
          model?: string;
          choices?: Array<{ message?: { content?: string } }>;
        };
        const content = data?.choices?.[0]?.message?.content;
        if (typeof content === 'string') {
          const parsed = parseGuideJsonResponse(content);
          if (parsed) return finalizeParsedDecision(parsed, data.model || 'openrouter');
        }
      }
    } catch {
      // fall through
    } finally {
      clearTimeout(timer);
    }
  }

  if (geminiApiKey) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const ai = new GoogleGenAI({ apiKey: geminiApiKey });
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Gemini guide-step timeout')), guideLlmTimeoutMs);
      });
      const response = await Promise.race([
        ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: [{ role: 'user', parts: [{ text: userJson }] }],
          config: {
            systemInstruction: GUIDE_SYSTEM_PROMPT,
            responseMimeType: 'application/json',
          },
        }),
        timeoutPromise,
      ]);
      const parsed = parseGuideJsonResponse(response.text || '');
      if (parsed) return finalizeParsedDecision(parsed, 'gemini');
    } catch (err) {
      logger.warn({ err }, 'Gemini guide-step fallback failed');
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  if (groqApiKey) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), guideLlmTimeoutMs);
    try {
      const res = await fetchImpl('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${groqApiKey}`,
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          response_format: { type: 'json_object' },
          temperature: 0.1,
          max_tokens: allowClarify ? 360 : 180,
          messages: [
            { role: 'system', content: GUIDE_SYSTEM_PROMPT },
            { role: 'user', content: userJson },
          ],
        }),
        signal: controller.signal,
      });
      if (res.ok) {
        const data = (await res.json()) as {
          model?: string;
          choices?: Array<{ message?: { content?: string } }>;
        };
        const content = data?.choices?.[0]?.message?.content;
        if (typeof content === 'string') {
          const parsed = parseGuideJsonResponse(content);
          if (parsed) return finalizeParsedDecision(parsed, 'groq');
        }
      }
    } catch {
      // fall through
    } finally {
      clearTimeout(timer);
    }
  }

  if (localClarify) {
    return { ...localClarify, provider: 'deterministic-dom-fallback' };
  }

  return {
    ...buildDeterministicGuideStep({
      goal,
      previousStepSummary,
      pageMap,
      stepNumber,
      currentRoute,
      confirmedPath,
      preferredTargetId,
      preferredRoute,
      availableRoutes,
    }),
    provider: 'deterministic-dom-fallback',
  };
}

export function createGuideStepRouter({ cfg, creditStore, fetchImpl }: GuideStepRouteDeps): Router {
  const router = Router();

  const handleStep = async (req: Request, res: Response) => {
    const parsed = GuideStepRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Invalid guide-step request payload',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }

    const scope = await extractAccessScope(req, cfg, {
      defaultUnauthenticatedRole: cfg.requireAuth ? 'PUBLIC' : 'ADMIN',
    });

    if (isPublicAuthContext(scope, parsed.data.currentRoute)) {
      if (!isPublicGuideGoalAllowed(parsed.data.goal, parsed.data.userReply)) {
        res.json({
          action: 'complete',
          totalSteps: parsed.data.stepNumber,
          tip: 'On the sign-in screen I can guide you to log in, reset your password, or create an account. Please sign in first for other tasks.',
          provider: 'public-auth-guard',
        });
        return;
      }
    }

    if (creditStore?.isBillingEnabled && scope.role !== 'PUBLIC') {
      const gate = await checkAndConsumeAiCredit({
        creditStore,
        scope,
        actionType: 'guide',
        res,
      });
      if (!gate.allowed) return;
    }

    try {
      const decision = await resolveGuideStepDecision({
        goal: parsed.data.goal,
        previousStepSummary: parsed.data.previousStepSummary,
        currentRoute: parsed.data.currentRoute,
        stepNumber: parsed.data.stepNumber,
        pageMap: parsed.data.pageMap,
        confirmedPath: parsed.data.confirmedPath,
        preferredTargetId: parsed.data.preferredTargetId,
        preferredRoute: parsed.data.preferredRoute,
        availableRoutes: parsed.data.availableRoutes,
        appContext: parsed.data.appContext,
        pageErrors: parsed.data.pageErrors,
        userReply: parsed.data.userReply,
        troubleshootingContext: parsed.data.troubleshootingContext,
        openRouterApiKey: cfg.openRouterApiKey,
        geminiApiKey: cfg.geminiApiKey,
        groqApiKey: cfg.groqApiKey,
        timeoutMs: cfg.llmTimeoutMs,
        fetchImpl,
      });
      res.json(decision);
    } catch {
      res.status(500).json({ error: 'Guide step failed.' });
    }
  };

  router.post('/', handleStep);
  router.post('/step', handleStep);

  return router;
}
