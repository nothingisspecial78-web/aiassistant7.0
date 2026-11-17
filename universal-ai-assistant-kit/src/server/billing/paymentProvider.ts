import crypto from 'node:crypto';
import { getPlanPriceInr, getPlanPricePaise } from './config.ts';
import type { CheckoutSessionResult, PaymentProvider, SubscriptionInterval } from './types.ts';

export class ManualTestPaymentProvider implements PaymentProvider {
  readonly name = 'manual_test_checkout';

  async createCheckout(input: {
    orgId: string;
    adminUserId: string;
    interval: SubscriptionInterval;
  }): Promise<CheckoutSessionResult> {
    const amountInr = getPlanPriceInr(input.interval);
    return {
      provider: this.name,
      providerRef: `pay_${input.orgId}_${crypto.randomUUID().slice(0, 8)}`,
      checkoutUrl: null,
      immediateActivation: true,
      amountInr,
      currency: 'INR',
      interval: input.interval,
    };
  }
}

export interface RazorpayConfigStatus {
  configured: boolean;
  keyId: string;
  hasSecret: boolean;
  webhookConfigured: boolean;
  testMode: boolean;
  liveKeyBlocked: boolean;
}

export class RazorpayPaymentProvider {
  private readonly keyId: string;
  private readonly keySecret: string;
  private readonly webhookSecret: string;
  private readonly testMode: boolean;

  constructor(opts?: {
    keyId?: string;
    keySecret?: string;
    webhookSecret?: string;
    testMode?: boolean;
  }) {
    this.keyId = (opts?.keyId ?? process.env.RAZORPAY_KEY_ID ?? '').trim();
    this.keySecret = (opts?.keySecret ?? process.env.RAZORPAY_KEY_SECRET ?? '').trim();
    this.webhookSecret = (opts?.webhookSecret ?? process.env.RAZORPAY_WEBHOOK_SECRET ?? '').trim();
    this.testMode =
      opts?.testMode ?? String(process.env.RAZORPAY_TEST_MODE || 'true').toLowerCase() !== 'false';
  }

  getConfigStatus(): RazorpayConfigStatus {
    const liveKeyBlocked = this.testMode && this.keyId.startsWith('rzp_live_');
    return {
      configured: Boolean(this.keyId && this.keySecret) && !liveKeyBlocked,
      keyId: this.keyId,
      hasSecret: Boolean(this.keySecret),
      webhookConfigured: Boolean(this.webhookSecret),
      testMode: this.testMode,
      liveKeyBlocked,
    };
  }

  private async getClient(): Promise<{
    orders: { create: (opts: Record<string, unknown>) => Promise<Record<string, unknown>> };
    payments: { fetch: (id: string) => Promise<Record<string, unknown>> };
  }> {
    const mod = await import('razorpay').catch(() => null);
    const RazorpayCtor = ((mod as unknown as { default?: unknown })?.default || mod) as unknown as
      | (new (opts: { key_id: string; key_secret: string }) => {
          orders: { create: (opts: Record<string, unknown>) => Promise<Record<string, unknown>> };
          payments: { fetch: (id: string) => Promise<Record<string, unknown>> };
        })
      | undefined;

    if (!RazorpayCtor) {
      throw new Error('razorpay package is not installed on this server.');
    }
    if (!this.keyId || !this.keySecret) {
      throw new Error('RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are not configured.');
    }
    return new RazorpayCtor({ key_id: this.keyId, key_secret: this.keySecret });
  }

  async createOrder(input: {
    orgId: string;
    adminUserId: string;
    plan: 'premium';
    interval: SubscriptionInterval;
    receipt: string;
  }): Promise<{
    orderId: string;
    amountPaise: number;
    amountInr: number;
    currency: 'INR';
    keyId: string;
  }> {
    const status = this.getConfigStatus();
    if (status.liveKeyBlocked) {
      throw new Error('Live Razorpay keys are blocked while RAZORPAY_TEST_MODE=true.');
    }
    if (!status.configured) {
      throw new Error('Razorpay credentials are missing.');
    }
    const amountInr = getPlanPriceInr(input.interval);
    const amountPaise = getPlanPricePaise(input.interval);
    const client = await this.getClient();
    const order = await client.orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt: input.receipt,
      notes: {
        orgId: input.orgId,
        adminUserId: input.adminUserId,
        interval: input.interval,
      },
    });
    return {
      orderId: String(order.id),
      amountPaise: Number(order.amount ?? amountPaise),
      amountInr,
      currency: 'INR',
      keyId: this.keyId,
    };
  }

  verifyCheckoutSignature(input: {
    orderId: string;
    paymentId: string;
    signature: string;
  }): boolean {
    if (!this.keySecret) return false;
    const expected = crypto
      .createHmac('sha256', this.keySecret)
      .update(`${input.orderId}|${input.paymentId}`)
      .digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(String(input.signature || ''));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  async fetchPayment(paymentId: string): Promise<{
    id: string;
    order_id?: string;
    status?: string;
    amount?: number;
    currency?: string;
    method?: string;
  }> {
    const client = await this.getClient();
    const res = await client.payments.fetch(paymentId);
    return {
      id: String(res.id || paymentId),
      order_id: typeof res.order_id === 'string' ? res.order_id : undefined,
      status: typeof res.status === 'string' ? res.status : undefined,
      amount: typeof res.amount === 'number' ? res.amount : undefined,
      currency: typeof res.currency === 'string' ? res.currency : undefined,
      method: typeof res.method === 'string' ? res.method : undefined,
    };
  }

  verifyWebhook(
    rawBody: string | Buffer,
    signature?: string
  ): { valid: boolean; skipped?: boolean; reason?: string } {
    if (!this.webhookSecret) {
      return { valid: false, skipped: true, reason: 'RAZORPAY_WEBHOOK_SECRET not set.' };
    }
    if (!signature) {
      return { valid: false, reason: 'Missing x-razorpay-signature header.' };
    }
    const expected = crypto
      .createHmac('sha256', this.webhookSecret)
      .update(rawBody)
      .digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { valid: false, reason: 'Webhook signature mismatch.' };
    }
    return { valid: true };
  }

  parseWebhookPayload(
    rawBody: string | Buffer,
    eventIdHeader?: string
  ): {
    handled: boolean;
    eventName?: string;
    eventId?: string;
    status?: 'active' | 'failed' | 'refunded';
    orderId?: string;
    paymentId?: string;
    amountPaise?: number;
    currency?: string;
    method?: string;
    interval?: SubscriptionInterval;
    errorReason?: string;
  } {
    const text = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
    const payload = JSON.parse(text || '{}') as Record<string, unknown>;
    const eventName = String(payload.event || '');
    const eventId = eventIdHeader || (typeof payload.id === 'string' ? payload.id : undefined);
    const paymentEntity = (
      (payload.payload as Record<string, unknown> | undefined)?.payment as
        | { entity?: Record<string, unknown> }
        | undefined
    )?.entity;

    if (!paymentEntity) {
      return { handled: false, eventName, eventId };
    }

    const orderId = typeof paymentEntity.order_id === 'string' ? paymentEntity.order_id : undefined;
    const paymentId = typeof paymentEntity.id === 'string' ? paymentEntity.id : undefined;
    const amountPaise =
      typeof paymentEntity.amount === 'number' ? paymentEntity.amount : undefined;
    const currency = typeof paymentEntity.currency === 'string' ? paymentEntity.currency : undefined;
    const method = typeof paymentEntity.method === 'string' ? paymentEntity.method : undefined;
    const notes = (paymentEntity.notes as Record<string, unknown> | undefined) || {};
    const interval = notes.interval === 'annual' ? 'annual' : undefined;

    if (eventName === 'payment.captured' || eventName === 'order.paid') {
      return {
        handled: true,
        eventName,
        eventId,
        status: 'active',
        orderId,
        paymentId,
        amountPaise,
        currency,
        method,
        interval,
      };
    }
    if (eventName === 'payment.failed') {
      return {
        handled: true,
        eventName,
        eventId,
        status: 'failed',
        orderId,
        paymentId,
        errorReason: String(
          paymentEntity.error_description || paymentEntity.error_reason || 'Payment failed'
        ),
      };
    }
    if (eventName === 'refund.created' || eventName === 'refund.processed') {
      return {
        handled: true,
        eventName,
        eventId,
        status: 'refunded',
        orderId,
        paymentId,
      };
    }
    return { handled: false, eventName, eventId };
  }
}
