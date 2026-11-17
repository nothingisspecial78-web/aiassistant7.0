import type { Response } from 'express';
import type { ServerConfig } from '../config.ts';
import type { OrgCreditStore } from './creditStore.ts';
import type { BillingStatusSnapshot } from './types.ts';
import type { AccessScope } from '../security/scope.ts';

export async function checkAndConsumeAiCredit(params: {
  creditStore: OrgCreditStore;
  scope: AccessScope;
  actionType?: string;
  cost?: number;
  orgIdFallback?: string;
  res: Response;
}): Promise<{ allowed: true; snapshot: BillingStatusSnapshot } | { allowed: false }> {
  const { creditStore, scope, actionType, cost = 1, orgIdFallback = 'default', res } = params;

  if (!creditStore.isBillingEnabled) {
    const snap = await creditStore.getStatus(
      'organizationId' in scope && scope.organizationId ? scope.organizationId : orgIdFallback,
      scope.role,
      scope.userId
    );
    return { allowed: true, snapshot: snap };
  }

  if (scope.role === 'PUBLIC') {
    const guestSnap = await creditStore.getStatus(orgIdFallback, 'PUBLIC', 'guest');
    res.status(401).json({
      error: guestSnap.blockedMessage || 'Please sign in to continue.',
      errorCode: 'SIGN_IN_REQUIRED',
      billing: guestSnap,
    });
    return { allowed: false };
  }

  const orgId =
    'organizationId' in scope && scope.organizationId ? scope.organizationId : orgIdFallback;

  const outcome = await creditStore.consumeCredit({
    orgId,
    userId: scope.userId,
    userRole: scope.role,
    actionType,
    cost,
  });

  if (!outcome.allowed) {
    res.status(outcome.httpStatus).json({
      error: outcome.message,
      errorCode: outcome.errorCode,
      billing: outcome.snapshot,
    });
    return { allowed: false };
  }

  return { allowed: true, snapshot: outcome.snapshot };
}

export async function verifyBillingAccessOnly(params: {
  creditStore: OrgCreditStore;
  scope: AccessScope;
  orgIdFallback?: string;
  cfg: ServerConfig;
}): Promise<{
  allowed: boolean;
  snapshot: BillingStatusSnapshot;
}> {
  const orgId =
    'organizationId' in params.scope && params.scope.organizationId
      ? params.scope.organizationId
      : params.orgIdFallback || 'default';
  const snapshot = await params.creditStore.getStatus(
    orgId,
    params.scope.role,
    params.scope.userId
  );
  return {
    allowed: snapshot.canUseAssistant,
    snapshot,
  };
}
