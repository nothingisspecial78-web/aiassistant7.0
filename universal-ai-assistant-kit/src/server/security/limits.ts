import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { SourceCitation } from '../../core/index.ts';
import type { ServerConfig } from '../config.ts';
import type { AuthedRequest } from '../auth.ts';

interface CacheEntry {
  answer: string;
  sources: SourceCitation[];
  refusal: boolean;
  model: string;
  expiresAt: number;
}

export class ResponseCache {
  private readonly store = new Map<string, CacheEntry>();

  constructor(private readonly ttlMs: number) {}

  makeKey(
    appId: string,
    question: string,
    language: string,
    routePath?: string,
    contextText?: string
  ): string {
    return crypto
      .createHash('sha256')
      .update(
        JSON.stringify({
          appId,
          q: question.trim().toLowerCase(),
          lang: language,
          route: routePath || '',
          ctx: (contextText || '').slice(0, 120),
        })
      )
      .digest('hex');
  }

  get(key: string): CacheEntry | null {
    const item = this.store.get(key);
    if (!item) return null;
    if (Date.now() > item.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return item;
  }

  set(key: string, entry: Omit<CacheEntry, 'expiresAt'>): void {
    if (this.store.size > 500) {
      const firstKey = this.store.keys().next().value;
      if (firstKey) this.store.delete(firstKey);
    }
    this.store.set(key, {
      ...entry,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  clearForApp(_appId: string): void {
    this.store.clear();
  }
}

function createWindowRateLimiter(windowMs: number, maxRequests: number, label: string) {
  const buckets = new Map<string, { count: number; resetAt: number }>();

  return function rateLimitMiddleware(req: AuthedRequest, res: Response, next: NextFunction): void {
    const key = `${req.appProfile?.appId || 'default'}:${req.authUser?.userId || req.ip || 'anon'}`;
    const now = Date.now();
    const bucket = buckets.get(key);

    if (!bucket || now > bucket.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    if (bucket.count >= maxRequests) {
      res.status(429).json({
        error: `Too many ${label} requests. Please wait a moment and try again.`,
      });
      return;
    }

    bucket.count += 1;
    next();
  };
}

export function createChatRateLimiter(cfg: ServerConfig) {
  return createWindowRateLimiter(60_000, cfg.rateLimitPerMin, 'chat');
}

export function createUploadRateLimiter(cfg: ServerConfig) {
  return createWindowRateLimiter(60_000, Math.max(10, Math.floor(cfg.rateLimitPerMin / 2)), 'upload');
}

export function createPaymentRateLimiter(cfg: ServerConfig) {
  return createWindowRateLimiter(60_000, Math.max(15, cfg.rateLimitPerMin), 'payment');
}

export class ConcurrentStreamGuard {
  private readonly active = new Map<string, number>();

  constructor(private readonly maxPerUser: number) {}

  acquire(key: string): boolean {
    const count = this.active.get(key) || 0;
    if (count >= this.maxPerUser) return false;
    this.active.set(key, count + 1);
    return true;
  }

  release(key: string): void {
    const count = this.active.get(key) || 0;
    if (count <= 1) this.active.delete(key);
    else this.active.set(key, count - 1);
  }
}

export function createConcurrentStreamGuard(cfg: ServerConfig) {
  return new ConcurrentStreamGuard(cfg.maxConcurrentStreamsPerUser);
}

export type { Request };
