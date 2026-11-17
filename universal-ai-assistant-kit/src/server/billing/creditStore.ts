import crypto from 'node:crypto';
import type { ServerConfig } from '../config.ts';
import {
  computeSubscriptionExpiry,
  getCurrentBillingPeriod,
  getPlanPriceInr,
  isAdminOrOwnerRole,
  loadBillingConfig,
} from './config.ts';
import { ManualTestPaymentProvider } from './paymentProvider.ts';
import type {
  BillingAuditRecord,
  BillingConfig,
  BillingStatusSnapshot,
  ConsumeCreditsOutcome,
  OrgCreditRecord,
  OrgPlan,
  OrgSubscriptionRecord,
  PaymentProvider,
  PaymentRecord,
  SubscriptionInterval,
  UsageLogRecord,
} from './types.ts';

export class OrgCreditStore {
  private readonly records = new Map<string, OrgCreditRecord>();
  private readonly subscriptions = new Map<string, OrgSubscriptionRecord[]>();
  private readonly usageLogs = new Map<string, UsageLogRecord[]>();
  private readonly paymentsByOrder = new Map<string, PaymentRecord>();
  private readonly auditLogs = new Map<string, BillingAuditRecord[]>();
  private readonly seenWebhookEvents = new Set<string>();

  readonly billingConfig: BillingConfig;
  readonly paymentProvider: PaymentProvider;

  constructor(
    _cfg: ServerConfig,
    opts?: {
      billingConfig?: Partial<BillingConfig>;
      paymentProvider?: PaymentProvider;
    }
  ) {
    this.billingConfig = loadBillingConfig(opts?.billingConfig);
    this.paymentProvider = opts?.paymentProvider || new ManualTestPaymentProvider();
  }

  get isBillingEnabled(): boolean {
    return this.billingConfig.mode !== 'disabled';
  }

  private getOrInitRecord(orgId: string): OrgCreditRecord {
    const existing = this.records.get(orgId);
    const { periodStart, periodEnd } = getCurrentBillingPeriod();
    if (existing) {
      if (existing.periodStart !== periodStart) {
        existing.periodStart = periodStart;
        existing.periodEnd = periodEnd;
        if (existing.plan === 'free') {
          existing.creditsMonthlyAllowance = this.billingConfig.freeMonthlyCredits;
          existing.creditsRemaining = this.billingConfig.freeMonthlyCredits;
        }
        existing.updatedAt = new Date().toISOString();
      }
      if (
        existing.plan === 'premium' &&
        existing.premiumExpiresAt &&
        Date.parse(existing.premiumExpiresAt) < Date.now()
      ) {
        existing.plan = 'free';
        existing.status = 'expired';
        existing.creditsRemaining = this.billingConfig.freeMonthlyCredits;
        existing.updatedAt = new Date().toISOString();
      }
      return existing;
    }

    const created: OrgCreditRecord = {
      orgId,
      plan: this.isBillingEnabled ? 'free' : 'premium',
      planInterval: null,
      creditsMonthlyAllowance: this.isBillingEnabled
        ? this.billingConfig.freeMonthlyCredits
        : 999999,
      creditsRemaining: this.isBillingEnabled
        ? this.billingConfig.freeMonthlyCredits
        : 999999,
      periodStart,
      periodEnd,
      premiumStartedAt: null,
      premiumExpiresAt: null,
      status: 'active',
      updatedAt: new Date().toISOString(),
    };
    this.records.set(orgId, created);
    return created;
  }

  private toSnapshot(
    rec: OrgCreditRecord,
    userRole: string,
    includeUsage = false
  ): BillingStatusSnapshot {
    const monthlyInr = this.billingConfig.monthlyPriceInr;
    const annualInr = this.billingConfig.annualPriceInr;
    const pricing = {
      currency: 'INR' as const,
      monthlyInr,
      annualInr,
      annualSavingsInr: Math.max(0, monthlyInr * 12 - annualInr),
      freeMonthlyCredits: this.billingConfig.freeMonthlyCredits,
    };

    if (!this.isBillingEnabled) {
      return {
        billingEnabled: false,
        orgId: rec.orgId,
        plan: 'premium',
        effectivePlan: 'premium',
        planInterval: null,
        creditsRemaining: 999999,
        creditsMonthlyAllowance: 999999,
        unlimited: true,
        periodStart: rec.periodStart,
        periodEnd: rec.periodEnd,
        status: 'active',
        premiumStartedAt: null,
        premiumExpiresAt: null,
        canUseAssistant: true,
        blockedReason: null,
        blockedMessage: null,
        pricing,
        canManageBilling: isAdminOrOwnerRole(userRole),
        allowDevPlanSwitch: this.billingConfig.allowDevPlanSwitch,
        ...(includeUsage ? { recentUsage: (this.usageLogs.get(rec.orgId) || []).slice(0, 20) } : {}),
      };
    }

    const effectivePlan: OrgPlan =
      rec.plan === 'premium' &&
      (!rec.premiumExpiresAt || Date.parse(rec.premiumExpiresAt) >= Date.now())
        ? 'premium'
        : 'free';

    const unlimited = effectivePlan === 'premium';
    const isAdmin = isAdminOrOwnerRole(userRole);
    let canUseAssistant = true;
    let blockedReason: BillingStatusSnapshot['blockedReason'] = null;
    let blockedMessage: string | null = null;

    if (String(userRole).toUpperCase() === 'PUBLIC') {
      canUseAssistant = false;
      blockedReason = 'SIGN_IN_REQUIRED';
      blockedMessage = 'Sign in to access the full AI assistant.';
    } else if (!unlimited && !isAdmin) {
      canUseAssistant = false;
      blockedReason = 'PLAN_UPGRADE_REQUIRED';
      blockedMessage = 'This workspace is on the Free plan. Ask your Admin to upgrade to Premium.';
    } else if (!unlimited && rec.creditsRemaining <= 0) {
      canUseAssistant = false;
      blockedReason = 'CREDITS_EXHAUSTED';
      blockedMessage = 'Monthly AI credits are exhausted. Upgrade to Premium for Unlimited usage.';
    }

    return {
      billingEnabled: true,
      orgId: rec.orgId,
      plan: rec.plan,
      effectivePlan,
      planInterval: rec.planInterval,
      creditsRemaining: rec.creditsRemaining,
      creditsMonthlyAllowance: rec.creditsMonthlyAllowance,
      unlimited,
      periodStart: rec.periodStart,
      periodEnd: rec.periodEnd,
      status: rec.status,
      premiumStartedAt: rec.premiumStartedAt,
      premiumExpiresAt: rec.premiumExpiresAt,
      canUseAssistant,
      blockedReason,
      blockedMessage,
      pricing,
      canManageBilling: isAdmin,
      allowDevPlanSwitch: this.billingConfig.allowDevPlanSwitch,
      ...(includeUsage ? { recentUsage: (this.usageLogs.get(rec.orgId) || []).slice(0, 20) } : {}),
    };
  }

  async getStatus(
    orgId: string,
    userRole: string,
    _userId: string
  ): Promise<BillingStatusSnapshot> {
    const rec = this.getOrInitRecord(orgId || 'default');
    return this.toSnapshot(rec, userRole, isAdminOrOwnerRole(userRole));
  }

  async consumeCredit(input: {
    orgId: string;
    userId: string;
    userRole: string;
    actionType?: string;
    cost?: number;
  }): Promise<ConsumeCreditsOutcome> {
    const rec = this.getOrInitRecord(input.orgId || 'default');

    if (!this.isBillingEnabled) {
      return {
        allowed: true,
        creditsCharged: 0,
        snapshot: this.toSnapshot(rec, input.userRole, false),
      };
    }

    const snap = this.toSnapshot(rec, input.userRole, false);
    if (!snap.canUseAssistant) {
      return {
        allowed: false,
        httpStatus: snap.blockedReason === 'SIGN_IN_REQUIRED' ? 401 : 402,
        errorCode: snap.blockedReason || 'CREDITS_EXHAUSTED',
        message: snap.blockedMessage || 'Unable to consume credits.',
        snapshot: snap,
      };
    }

    const cost = snap.unlimited ? 0 : Math.max(0, input.cost ?? 1);
    if (!snap.unlimited) {
      rec.creditsRemaining = Math.max(0, rec.creditsRemaining - cost);
      rec.updatedAt = new Date().toISOString();
    }

    const logs = this.usageLogs.get(rec.orgId) || [];
    logs.unshift({
      id: `usg_${crypto.randomUUID().slice(0, 10)}`,
      orgId: rec.orgId,
      userId: input.userId,
      userRole: input.userRole,
      actionType: input.actionType || 'chat',
      creditsUsed: cost,
      creditsRemainingAfter: snap.unlimited ? null : rec.creditsRemaining,
      createdAt: new Date().toISOString(),
    });
    this.usageLogs.set(rec.orgId, logs.slice(0, 200));

    return {
      allowed: true,
      creditsCharged: cost,
      snapshot: this.toSnapshot(rec, input.userRole, false),
    };
  }

  async fetchUsageLogs(orgId: string, limit = 50): Promise<UsageLogRecord[]> {
    return (this.usageLogs.get(orgId || 'default') || []).slice(0, limit);
  }

  async activatePremium(input: {
    orgId: string;
    adminUserId: string;
    interval: SubscriptionInterval;
    provider: string;
    providerRef: string | null;
  }): Promise<{ subscription: OrgSubscriptionRecord }> {
    const orgId = input.orgId || 'default';
    const rec = this.getOrInitRecord(orgId);
    const now = new Date();
    const expiresAt = computeSubscriptionExpiry(input.interval, now);
    rec.plan = 'premium';
    rec.planInterval = input.interval;
    rec.status = 'active';
    rec.premiumStartedAt = now.toISOString();
    rec.premiumExpiresAt = expiresAt;
    rec.updatedAt = now.toISOString();

    const sub: OrgSubscriptionRecord = {
      id: `sub_${crypto.randomUUID().slice(0, 10)}`,
      orgId,
      plan: 'premium',
      interval: input.interval,
      amountInr: getPlanPriceInr(input.interval, this.billingConfig),
      currency: 'INR',
      status: 'active',
      provider: input.provider,
      providerRef: input.providerRef,
      startedAt: rec.premiumStartedAt,
      expiresAt,
      cancelledAt: null,
      createdByUserId: input.adminUserId,
      createdAt: rec.premiumStartedAt,
    };
    const list = this.subscriptions.get(orgId) || [];
    list.unshift(sub);
    this.subscriptions.set(orgId, list);
    return { subscription: sub };
  }

  async cancelPremium(input: { orgId: string }): Promise<void> {
    const rec = this.getOrInitRecord(input.orgId || 'default');
    rec.status = 'cancelled';
    rec.updatedAt = new Date().toISOString();
  }

  async setPlanViaDevSwitch(input: {
    orgId: string;
    adminUserId: string;
    plan: OrgPlan;
    interval?: SubscriptionInterval;
    creditsRemaining?: number;
    expiresAt?: string;
  }): Promise<BillingStatusSnapshot> {
    const orgId = input.orgId || 'default';
    const rec = this.getOrInitRecord(orgId);
    rec.plan = input.plan;
    rec.status = 'active';
    if (input.plan === 'premium') {
      rec.planInterval = input.interval || 'monthly';
      rec.premiumStartedAt = new Date().toISOString();
      rec.premiumExpiresAt =
        input.expiresAt || computeSubscriptionExpiry(rec.planInterval, new Date());
    } else {
      rec.planInterval = null;
      rec.premiumStartedAt = null;
      rec.premiumExpiresAt = null;
      rec.creditsRemaining =
        input.creditsRemaining ?? this.billingConfig.freeMonthlyCredits;
    }
    rec.updatedAt = new Date().toISOString();
    return this.toSnapshot(rec, 'ADMIN', true);
  }

  async runMonthlyCronReset(): Promise<{ resetCount: number }> {
    const { periodStart, periodEnd } = getCurrentBillingPeriod();
    let resetCount = 0;
    for (const rec of this.records.values()) {
      rec.periodStart = periodStart;
      rec.periodEnd = periodEnd;
      if (rec.plan === 'free') {
        rec.creditsRemaining = this.billingConfig.freeMonthlyCredits;
        resetCount += 1;
      }
    }
    return { resetCount };
  }

  async createPaymentOrderRecord(input: {
    orgId: string;
    userId: string;
    plan: 'premium';
    interval: SubscriptionInterval;
    amountInr: number;
    amountPaise: number;
    razorpayOrderId: string;
    idempotencyKey?: string;
  }): Promise<PaymentRecord> {
    const now = new Date().toISOString();
    const rec: PaymentRecord = {
      id: `pay_${crypto.randomUUID().slice(0, 10)}`,
      orgId: input.orgId,
      userId: input.userId,
      plan: input.plan,
      interval: input.interval,
      amountInr: input.amountInr,
      amountPaise: input.amountPaise,
      currency: 'INR',
      razorpayOrderId: input.razorpayOrderId,
      razorpayPaymentId: null,
      status: 'created',
      method: null,
      errorReason: null,
      createdAt: now,
      updatedAt: now,
    };
    this.paymentsByOrder.set(input.razorpayOrderId, rec);
    return rec;
  }

  async getPaymentByOrderId(orderId: string): Promise<PaymentRecord | undefined> {
    return this.paymentsByOrder.get(orderId);
  }

  async markPaymentPaidAndActivatePremium(input: {
    orderId: string;
    razorpayPaymentId: string;
    actorUserId: string;
    intervalOverride?: SubscriptionInterval;
    method?: string | null;
    source?: string;
    eventId?: string;
  }): Promise<{
    alreadyProcessed: boolean;
    extended: boolean;
    payment: PaymentRecord | null;
    subscription: OrgSubscriptionRecord | null;
  }> {
    const payment = this.paymentsByOrder.get(input.orderId);
    if (!payment) {
      return { alreadyProcessed: false, extended: false, payment: null, subscription: null };
    }
    if (payment.status === 'paid') {
      return {
        alreadyProcessed: true,
        extended: false,
        payment,
        subscription: (this.subscriptions.get(payment.orgId) || [])[0] || null,
      };
    }
    payment.status = 'paid';
    payment.razorpayPaymentId = input.razorpayPaymentId;
    payment.method = input.method || payment.method;
    payment.updatedAt = new Date().toISOString();

    const { subscription } = await this.activatePremium({
      orgId: payment.orgId,
      adminUserId: input.actorUserId,
      interval: input.intervalOverride || payment.interval,
      provider: 'razorpay',
      providerRef: input.razorpayPaymentId,
    });
    this.appendAudit(payment.orgId, input.actorUserId, 'payment_verified', {
      orderId: input.orderId,
      paymentId: input.razorpayPaymentId,
      source: input.source || 'verify',
    });
    return { alreadyProcessed: false, extended: true, payment, subscription };
  }

  async markPaymentFailed(input: {
    orderId?: string;
    razorpayPaymentId?: string;
    errorReason: string;
    actorUserId: string;
  }): Promise<PaymentRecord | null> {
    if (!input.orderId) return null;
    const payment = this.paymentsByOrder.get(input.orderId);
    if (!payment) return null;
    payment.status = 'failed';
    payment.razorpayPaymentId = input.razorpayPaymentId || payment.razorpayPaymentId;
    payment.errorReason = input.errorReason;
    payment.updatedAt = new Date().toISOString();
    this.appendAudit(payment.orgId, input.actorUserId, 'payment_failed', {
      orderId: input.orderId,
      reason: input.errorReason,
    });
    return payment;
  }

  async markPaymentRefunded(input: {
    orderId?: string;
    razorpayPaymentId?: string;
    actorUserId: string;
  }): Promise<void> {
    if (!input.orderId) return;
    const payment = this.paymentsByOrder.get(input.orderId);
    if (!payment) return;
    payment.status = 'refunded';
    payment.updatedAt = new Date().toISOString();
    this.appendAudit(payment.orgId, input.actorUserId, 'payment_refunded', {
      orderId: input.orderId,
    });
  }

  async recordWebhookEventIfNew(input: {
    eventId: string;
    eventName: string;
    orderId?: string;
    paymentId?: string;
  }): Promise<boolean> {
    if (this.seenWebhookEvents.has(input.eventId)) return false;
    this.seenWebhookEvents.add(input.eventId);
    return true;
  }

  async listPayments(orgId: string, limit = 50): Promise<PaymentRecord[]> {
    return Array.from(this.paymentsByOrder.values())
      .filter((p) => p.orgId === orgId)
      .slice(-limit)
      .reverse();
  }

  async listBillingAudit(orgId: string, limit = 50): Promise<BillingAuditRecord[]> {
    return (this.auditLogs.get(orgId) || []).slice(0, limit);
  }

  private appendAudit(
    orgId: string,
    actorUserId: string,
    action: string,
    details: Record<string, unknown>
  ): void {
    const list = this.auditLogs.get(orgId) || [];
    list.unshift({
      id: `ba_${crypto.randomUUID().slice(0, 10)}`,
      orgId,
      actorUserId,
      action,
      details,
      createdAt: new Date().toISOString(),
    });
    this.auditLogs.set(orgId, list.slice(0, 100));
  }
}
