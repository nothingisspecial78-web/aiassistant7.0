import type { BillingConfig, SubscriptionInterval } from './types.ts';

export const DEFAULT_FREE_MONTHLY_CREDITS = 100;
export const DEFAULT_MONTHLY_PRICE_INR = 299;
export const DEFAULT_ANNUAL_PRICE_INR = 2999;

export function loadBillingConfig(overrides?: Partial<BillingConfig>): BillingConfig {
  const modeEnv = (process.env.AI_BILLING_MODE || '').trim().toLowerCase();
  const mode =
    overrides?.mode ??
    (modeEnv === 'credits' || modeEnv === 'enabled' ? 'credits' : 'disabled');

  return {
    mode,
    freeMonthlyCredits:
      overrides?.freeMonthlyCredits ??
      Number(process.env.AI_FREE_MONTHLY_CREDITS || DEFAULT_FREE_MONTHLY_CREDITS),
    monthlyPriceInr:
      overrides?.monthlyPriceInr ??
      Number(process.env.AI_MONTHLY_PRICE_INR || DEFAULT_MONTHLY_PRICE_INR),
    annualPriceInr:
      overrides?.annualPriceInr ??
      Number(process.env.AI_ANNUAL_PRICE_INR || DEFAULT_ANNUAL_PRICE_INR),
    allowDevPlanSwitch: overrides?.allowDevPlanSwitch ?? isDevPlanSwitchAllowed(),
  };
}

export function getPlanPriceInr(
  interval: SubscriptionInterval,
  cfg?: Partial<BillingConfig>
): number {
  const monthly = cfg?.monthlyPriceInr ?? DEFAULT_MONTHLY_PRICE_INR;
  const annual = cfg?.annualPriceInr ?? DEFAULT_ANNUAL_PRICE_INR;
  return interval === 'annual' ? annual : monthly;
}

export function getPlanPricePaise(
  interval: SubscriptionInterval,
  cfg?: Partial<BillingConfig>
): number {
  return getPlanPriceInr(interval, cfg) * 100;
}

export function getFreeMonthlyCredits(cfg?: Partial<BillingConfig>): number {
  return cfg?.freeMonthlyCredits ?? DEFAULT_FREE_MONTHLY_CREDITS;
}

export function getCurrentBillingPeriod(now = new Date()): {
  periodStart: string;
  periodEnd: string;
} {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const start = new Date(Date.UTC(y, m, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(y, m + 1, 0, 23, 59, 59, 999));
  return {
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
  };
}

export function computeSubscriptionExpiry(
  interval: SubscriptionInterval,
  from = new Date()
): string {
  const exp = new Date(from.getTime());
  if (interval === 'annual') {
    exp.setUTCFullYear(exp.getUTCFullYear() + 1);
  } else {
    exp.setUTCMonth(exp.getUTCMonth() + 1);
  }
  return exp.toISOString();
}

export function isDevPlanSwitchAllowed(): boolean {
  if (process.env.ALLOW_DEV_PLAN_SWITCH === 'true') return true;
  if (process.env.ALLOW_DEV_PLAN_SWITCH === 'false') return false;
  return process.env.NODE_ENV !== 'production';
}

export function isAdminOrOwnerRole(role: string): boolean {
  const upper = String(role || '').toUpperCase();
  return upper === 'ADMIN' || upper === 'SUPER_ADMIN' || upper === 'OWNER';
}
