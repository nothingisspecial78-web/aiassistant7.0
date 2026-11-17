export type BillingMode = 'disabled' | 'credits';
export type OrgPlan = 'free' | 'premium';
export type SubscriptionInterval = 'monthly' | 'annual';
export type SubscriptionStatus = 'active' | 'cancelled' | 'expired';

export interface BillingConfig {
  mode: BillingMode;
  freeMonthlyCredits: number;
  monthlyPriceInr: number;
  annualPriceInr: number;
  allowDevPlanSwitch: boolean;
}

export interface OrgCreditRecord {
  orgId: string;
  plan: OrgPlan;
  planInterval: SubscriptionInterval | null;
  creditsMonthlyAllowance: number;
  creditsRemaining: number;
  periodStart: string;
  periodEnd: string;
  premiumStartedAt: string | null;
  premiumExpiresAt: string | null;
  status: SubscriptionStatus;
  updatedAt: string;
}

export interface OrgSubscriptionRecord {
  id: string;
  orgId: string;
  plan: OrgPlan;
  interval: SubscriptionInterval;
  amountInr: number;
  currency: 'INR';
  status: SubscriptionStatus;
  provider: string;
  providerRef: string | null;
  startedAt: string;
  expiresAt: string;
  cancelledAt: string | null;
  createdByUserId: string;
  createdAt: string;
}

export interface UsageLogRecord {
  id: string;
  orgId: string;
  userId: string;
  userRole: string;
  actionType: string;
  creditsUsed: number;
  creditsRemainingAfter: number | null;
  createdAt: string;
}

export interface BillingStatusSnapshot {
  billingEnabled: boolean;
  orgId: string;
  plan: OrgPlan;
  effectivePlan: OrgPlan;
  planInterval: SubscriptionInterval | null;
  creditsRemaining: number;
  creditsMonthlyAllowance: number;
  unlimited: boolean;
  periodStart: string;
  periodEnd: string;
  status: SubscriptionStatus;
  premiumStartedAt: string | null;
  premiumExpiresAt: string | null;
  canUseAssistant: boolean;
  blockedReason:
    | null
    | 'PLAN_UPGRADE_REQUIRED'
    | 'CREDITS_EXHAUSTED'
    | 'SIGN_IN_REQUIRED';
  blockedMessage: string | null;
  pricing: {
    currency: 'INR';
    monthlyInr: number;
    annualInr: number;
    annualSavingsInr: number;
    freeMonthlyCredits: number;
  };
  canManageBilling: boolean;
  allowDevPlanSwitch: boolean;
  recentUsage?: UsageLogRecord[];
}

export type PaymentOrderStatus = 'created' | 'paid' | 'failed' | 'refunded';

export interface PaymentRecord {
  id: string;
  orgId: string;
  userId: string;
  plan: 'premium';
  interval: SubscriptionInterval;
  amountInr: number;
  amountPaise: number;
  currency: 'INR';
  razorpayOrderId: string;
  razorpayPaymentId: string | null;
  status: PaymentOrderStatus;
  method: string | null;
  errorReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BillingAuditRecord {
  id: string;
  orgId: string;
  actorUserId: string;
  action: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface CheckoutSessionResult {
  provider: string;
  providerRef: string;
  checkoutUrl: string | null;
  immediateActivation: boolean;
  amountInr: number;
  currency: 'INR';
  interval: SubscriptionInterval;
}

export interface PaymentProvider {
  readonly name: string;
  createCheckout(input: {
    orgId: string;
    adminUserId: string;
    interval: SubscriptionInterval;
  }): Promise<CheckoutSessionResult>;
}

export type ConsumeCreditsOutcome =
  | {
      allowed: true;
      creditsCharged: number;
      snapshot: BillingStatusSnapshot;
    }
  | {
      allowed: false;
      httpStatus: 401 | 402 | 403;
      errorCode: 'SIGN_IN_REQUIRED' | 'PLAN_UPGRADE_REQUIRED' | 'CREDITS_EXHAUSTED';
      message: string;
      snapshot: BillingStatusSnapshot;
    };
