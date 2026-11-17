import { Router, type Response } from 'express';
import { z } from 'zod';
import type { WidgetBillingStatus } from '../../core/index.ts';
import type { AuthedRequest } from '../auth.ts';
import { isAdminOrOwnerRole, isDevPlanSwitchAllowed } from '../billing/config.ts';
import type { OrgCreditStore } from '../billing/creditStore.ts';
import type { BillingStatusSnapshot } from '../billing/types.ts';
import type { ServerConfig } from '../config.ts';
import { extractAccessScope } from '../security/scope.ts';

const SubscribeBodySchema = z.object({
  appId: z.string().optional(),
  interval: z.enum(['monthly', 'annual']).default('monthly'),
});

const DevSwitchBodySchema = z.object({
  appId: z.string().optional(),
  plan: z.enum(['free', 'premium']),
  interval: z.enum(['monthly', 'annual']).optional(),
  creditsRemaining: z.number().int().min(0).max(100000).optional(),
  expiresAt: z.string().datetime().optional(),
});

function resolveOrgIdFromScope(
  scope: Awaited<ReturnType<typeof extractAccessScope>>,
  reqBodyOrQueryOrg?: string
): string {
  if ('organizationId' in scope && scope.organizationId) {
    return scope.organizationId;
  }
  if (reqBodyOrQueryOrg && reqBodyOrQueryOrg.trim()) {
    return reqBodyOrQueryOrg.trim();
  }
  return 'default';
}

function toWidgetBillingStatus(
  snap: BillingStatusSnapshot,
  role: string
): WidgetBillingStatus & BillingStatusSnapshot {
  const lockedReason: WidgetBillingStatus['lockedReason'] =
    snap.blockedReason === 'CREDITS_EXHAUSTED'
      ? 'CREDITS_EXHAUSTED'
      : snap.blockedReason === 'PLAN_UPGRADE_REQUIRED'
        ? 'UPGRADE_REQUIRED'
        : null;

  return {
    ...snap,
    role,
    isAdmin: snap.canManageBilling,
    lockedReason,
    devSwitchEnabled: snap.allowDevPlanSwitch,
  };
}

export function createBillingRouter(params: {
  cfg: ServerConfig;
  creditStore: OrgCreditStore;
}): Router {
  const router = Router();
  const defaultRole = params.cfg.requireAuth ? 'PUBLIC' : 'ADMIN';

  router.get('/status', async (req: AuthedRequest, res: Response) => {
    const scope = await extractAccessScope(req, params.cfg, {
      defaultUnauthenticatedRole: defaultRole,
    });
    const orgId = resolveOrgIdFromScope(
      scope,
      typeof req.query.orgId === 'string' ? req.query.orgId : undefined
    );
    const snap = await params.creditStore.getStatus(orgId, scope.role, scope.userId);
    res.json(toWidgetBillingStatus(snap, scope.role));
  });

  router.get('/usage', async (req: AuthedRequest, res: Response) => {
    const scope = await extractAccessScope(req, params.cfg, {
      defaultUnauthenticatedRole: defaultRole,
    });
    if (!isAdminOrOwnerRole(scope.role)) {
      res.status(403).json({
        error: 'Only workspace Admin can view billing usage logs.',
        errorCode: 'FORBIDDEN',
      });
      return;
    }
    const orgId = resolveOrgIdFromScope(
      scope,
      typeof req.query.orgId === 'string' ? req.query.orgId : undefined
    );
    const limit = Number(req.query.limit || 50);
    const logs = await params.creditStore.fetchUsageLogs(orgId, Number.isFinite(limit) ? limit : 50);
    res.json({ orgId, logs });
  });

  router.post('/subscribe', async (req: AuthedRequest, res: Response) => {
    const scope = await extractAccessScope(req, params.cfg, {
      defaultUnauthenticatedRole: defaultRole,
    });
    if (!isAdminOrOwnerRole(scope.role)) {
      res.status(403).json({
        error: 'Only workspace Admin can manage billing plans.',
        errorCode: 'FORBIDDEN',
      });
      return;
    }
    const parsed = SubscribeBodySchema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid subscription payload.' });
      return;
    }
    const orgId = resolveOrgIdFromScope(
      scope,
      typeof req.body?.orgId === 'string' ? req.body.orgId : undefined
    );

    const checkout = await params.creditStore.paymentProvider.createCheckout({
      orgId,
      adminUserId: scope.userId,
      interval: parsed.data.interval,
    });

    if (checkout.immediateActivation) {
      const activated = await params.creditStore.activatePremium({
        orgId,
        adminUserId: scope.userId,
        interval: parsed.data.interval,
        provider: checkout.provider,
        providerRef: checkout.providerRef,
      });
      const snap = await params.creditStore.getStatus(orgId, scope.role, scope.userId);
      res.json({
        ok: true,
        checkoutUrl: checkout.checkoutUrl,
        subscription: activated.subscription,
        status: toWidgetBillingStatus(snap, scope.role),
      });
      return;
    }

    const snap = await params.creditStore.getStatus(orgId, scope.role, scope.userId);
    res.json({
      ok: true,
      checkoutUrl: checkout.checkoutUrl,
      status: toWidgetBillingStatus(snap, scope.role),
    });
  });

  router.post('/cancel', async (req: AuthedRequest, res: Response) => {
    const scope = await extractAccessScope(req, params.cfg, {
      defaultUnauthenticatedRole: defaultRole,
    });
    if (!isAdminOrOwnerRole(scope.role)) {
      res.status(403).json({
        error: 'Only workspace Admin can cancel the Premium subscription.',
        errorCode: 'FORBIDDEN',
      });
      return;
    }
    const orgId = resolveOrgIdFromScope(
      scope,
      typeof req.body?.orgId === 'string' ? req.body.orgId : undefined
    );
    await params.creditStore.cancelPremium({ orgId });
    const snap = await params.creditStore.getStatus(orgId, scope.role, scope.userId);
    res.json({ ok: true, status: toWidgetBillingStatus(snap, scope.role) });
  });

  router.post('/dev-switch', async (req: AuthedRequest, res: Response) => {
    if (!isDevPlanSwitchAllowed()) {
      res.status(404).json({ error: 'Test plan switcher is disabled in this environment.' });
      return;
    }
    const scope = await extractAccessScope(req, params.cfg, {
      defaultUnauthenticatedRole: defaultRole,
    });
    if (!isAdminOrOwnerRole(scope.role)) {
      res.status(403).json({
        error: 'Only workspace Admin can switch workspace plans.',
        errorCode: 'FORBIDDEN',
      });
      return;
    }
    const parsed = DevSwitchBodySchema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid dev plan switch payload.' });
      return;
    }
    const orgId = resolveOrgIdFromScope(
      scope,
      typeof req.body?.orgId === 'string' ? req.body.orgId : undefined
    );
    const snap = await params.creditStore.setPlanViaDevSwitch({
      orgId,
      adminUserId: scope.userId,
      plan: parsed.data.plan,
      interval: parsed.data.interval,
      creditsRemaining: parsed.data.creditsRemaining,
      expiresAt: parsed.data.expiresAt,
    });
    res.json({ ok: true, status: toWidgetBillingStatus(snap, scope.role) });
  });

  router.post('/cron-reset', async (req, res: Response) => {
    const secret = process.env.CRON_SECRET || '';
    const auth = String(req.headers.authorization || '');
    if (secret && auth !== `Bearer ${secret}`) {
      res.status(401).json({ error: 'Unauthorized cron call.' });
      return;
    }
    const out = await params.creditStore.runMonthlyCronReset();
    res.json({ ok: true, ...out });
  });

  return router;
}
