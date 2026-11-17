import { PassThrough } from 'node:stream';
import { IncomingMessage, ServerResponse } from 'node:http';
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { DEFAULT_APP_ID, type AppProfile } from '../core/index.ts';
import type { ServerConfig } from './config.ts';
import type { ProfileRegistry } from './profiles/loader.ts';
import { logger } from './config.ts';

export interface ResolvedHostUser {
  userId: string;
  role?: string;
  organizationId?: string;
  sectorId?: string;
  sectorIds?: string[];
  studentId?: string;
  name?: string;
  email?: string;
}

export type ResolveUserFn = (
  req: Request
) => ResolvedHostUser | null | undefined | Promise<ResolvedHostUser | null | undefined>;

export interface AuthedRequest extends Request {
  appProfile?: AppProfile;
  authUser?: {
    userId: string;
    rawToken: string;
    role?: string;
    organizationId?: string;
    sectorIds?: string[];
    studentId?: string;
    name?: string;
  };
  resolvedScope?: import('./security/scope.ts').AccessScope;
}

export type LocalHttpHandler = (req: IncomingMessage, res: ServerResponse) => void;

const localHandlers = new Map<string, LocalHttpHandler>();

export function registerLocalHandler(prefix: string, handler: LocalHttpHandler): void {
  localHandlers.set(prefix.replace(/\/$/, ''), handler);
}

export function unregisterLocalHandler(prefix: string): void {
  localHandlers.delete(prefix.replace(/\/$/, ''));
}

export async function dispatchInProcess(
  handler: LocalHttpHandler,
  targetUrl: string | URL,
  init: RequestInit = {}
): Promise<globalThis.Response> {
  const url = typeof targetUrl === 'string' ? new URL(targetUrl, 'http://localhost') : targetUrl;
  const method = (init.method || 'GET').toUpperCase();
  const headersObj: Record<string, string> = {};

  if (init.headers) {
    if (init.headers instanceof Headers) {
      init.headers.forEach((v, k) => {
        headersObj[k.toLowerCase()] = v;
      });
    } else if (Array.isArray(init.headers)) {
      for (const [k, v] of init.headers) {
        headersObj[String(k).toLowerCase()] = String(v);
      }
    } else {
      for (const [k, v] of Object.entries(init.headers)) {
        if (v !== undefined) headersObj[k.toLowerCase()] = String(v);
      }
    }
  }

  let bodyBuf: Buffer | null = null;
  if (init.body !== undefined && init.body !== null) {
    if (typeof init.body === 'string') {
      bodyBuf = Buffer.from(init.body, 'utf8');
    } else if (Buffer.isBuffer(init.body)) {
      bodyBuf = init.body;
    } else if (init.body instanceof Uint8Array) {
      bodyBuf = Buffer.from(init.body);
    } else {
      bodyBuf = Buffer.from(String(init.body), 'utf8');
    }
    if (bodyBuf && !headersObj['content-length']) {
      headersObj['content-length'] = String(bodyBuf.byteLength);
    }
  }

  const reqSocket = new PassThrough();
  const req = new IncomingMessage(reqSocket as unknown as import('node:net').Socket);
  req.method = method;
  req.url = `${url.pathname}${url.search}`;
  req.headers = headersObj;
  if (bodyBuf && bodyBuf.byteLength > 0) {
    req.push(bodyBuf);
  }
  req.push(null);

  return new Promise<globalThis.Response>((resolve) => {
    const res = new ServerResponse(req);
    const chunks: Buffer[] = [];
    const origWrite = res.write.bind(res);
    const origEnd = res.end.bind(res);

    res.write = ((
      chunk: unknown,
      encodingOrCb?: BufferEncoding | ((error?: Error | null) => void),
      cb?: (error?: Error | null) => void
    ) => {
      if (chunk !== undefined && chunk !== null) {
        const buf = Buffer.isBuffer(chunk)
          ? chunk
          : typeof chunk === 'string'
            ? Buffer.from(chunk, typeof encodingOrCb === 'string' ? encodingOrCb : 'utf8')
            : Buffer.from(chunk as Uint8Array);
        chunks.push(buf);
      }
      return origWrite(chunk as string, encodingOrCb as BufferEncoding, cb);
    }) as typeof res.write;

    res.end = ((
      chunk?: unknown,
      encodingOrCb?: BufferEncoding | (() => void),
      cb?: () => void
    ) => {
      if (typeof chunk !== 'function' && chunk !== undefined && chunk !== null) {
        const buf = Buffer.isBuffer(chunk)
          ? chunk
          : typeof chunk === 'string'
            ? Buffer.from(chunk, typeof encodingOrCb === 'string' ? encodingOrCb : 'utf8')
            : Buffer.from(chunk as Uint8Array);
        chunks.push(buf);
      }
      const result = origEnd(chunk as string, encodingOrCb as BufferEncoding, cb);

      const outHeaders = new Headers();
      for (const [k, v] of Object.entries(res.getHeaders())) {
        if (v === undefined) continue;
        if (Array.isArray(v)) {
          for (const item of v) outHeaders.append(k, String(item));
        } else {
          outHeaders.set(k, String(v));
        }
      }

      const body = Buffer.concat(chunks);
      resolve(
        new globalThis.Response(body.byteLength > 0 ? new Uint8Array(body) : null, {
          status: res.statusCode || 200,
          statusText: res.statusMessage || 'OK',
          headers: outHeaders,
        })
      );
      return result;
    }) as typeof res.end;

    try {
      handler(req, res);
    } catch (err) {
      resolve(
        new globalThis.Response(
          JSON.stringify({ error: err instanceof Error ? err.message : 'Local handler error' }),
          { status: 500, headers: { 'content-type': 'application/json' } }
        )
      );
    }
  });
}

export async function appInternalFetch(
  targetUrl: string | URL,
  init: RequestInit = {}
): Promise<globalThis.Response> {
  const url = typeof targetUrl === 'string' ? new URL(targetUrl, 'http://localhost') : targetUrl;
  for (const [prefix, handler] of localHandlers.entries()) {
    if (url.pathname.startsWith(prefix)) {
      return dispatchInProcess(handler, url, init);
    }
  }
  return fetch(url.toString(), init);
}

export function resolveAppBaseUrl(
  profileBaseUrl: string | undefined,
  port: number,
  appId: string
): string {
  if (profileBaseUrl && profileBaseUrl.trim()) {
    if (profileBaseUrl.startsWith('http://') || profileBaseUrl.startsWith('https://')) {
      return profileBaseUrl;
    }
    return `http://127.0.0.1:${port}${profileBaseUrl.startsWith('/') ? '' : '/'}${profileBaseUrl}`;
  }
  return `http://127.0.0.1:${port}/api/${appId}`;
}

export async function verifyUserToken(
  token: string,
  profile: AppProfile,
  cfg: ServerConfig
): Promise<{ userId: string; role?: string; organizationId?: string; studentId?: string } | null> {
  if (!token) return null;

  if (profile.auth.mode === 'none') {
    return { userId: token.slice(0, 64) };
  }

  try {
    const decoded = jwt.verify(token, cfg.authSecret) as jwt.JwtPayload | string;
    if (typeof decoded === 'string') {
      return { userId: decoded };
    }
    const userId = String(
      decoded.sub || decoded.id || decoded.userId || decoded.email || 'user'
    );
    return {
      userId,
      role: typeof decoded.role === 'string' ? decoded.role : undefined,
      organizationId:
        typeof decoded.organizationId === 'string' ? decoded.organizationId : undefined,
      studentId: typeof decoded.studentId === 'string' ? decoded.studentId : undefined,
    };
  } catch (err) {
    logger.debug({ err }, 'JWT verification skipped or invalid');
  }

  const verifyUrl = cfg.authVerifyUrl || '';
  if (verifyUrl) {
    try {
      const target = verifyUrl.startsWith('http')
        ? verifyUrl
        : `http://127.0.0.1:${cfg.port}${verifyUrl.startsWith('/') ? '' : '/'}${verifyUrl}`;
      const res = await appInternalFetch(target, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = (await res.json()) as {
          user?: { id?: string; role?: string; organizationId?: string; studentId?: string };
          id?: string;
        };
        const userId = data.user?.id || data.id;
        if (userId) {
          return {
            userId: String(userId),
            role: data.user?.role,
            organizationId: data.user?.organizationId,
            studentId: data.user?.studentId,
          };
        }
      }
    } catch {
      // ignore network error in optional remote verification
    }
  }

  return null;
}

export function createAuthMiddleware(
  profiles: ProfileRegistry,
  cfg: ServerConfig,
  resolveUser?: ResolveUserFn
) {
  return async function authMiddleware(
    req: AuthedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    const bodyAppId =
      req.body && typeof req.body === 'object' && typeof req.body.appId === 'string'
        ? req.body.appId
        : undefined;
    const queryAppId = typeof req.query.appId === 'string' ? req.query.appId : undefined;
    const headerAppId = req.header('x-app-id') || undefined;
    const requestedAppId = headerAppId || bodyAppId || queryAppId || DEFAULT_APP_ID;

    const profile =
      profiles.getProfile(requestedAppId) || profiles.getDefaultProfile();
    if (!profile) {
      res.status(404).json({ error: `Unknown app profile "${requestedAppId}".` });
      return;
    }

    const authHeader = req.header('authorization') || '';
    const bearer = authHeader.toLowerCase().startsWith('bearer ')
      ? authHeader.slice(7).trim()
      : '';

    let hostResolved: ResolvedHostUser | null | undefined;
    if (resolveUser) {
      try {
        hostResolved = await resolveUser(req);
      } catch (err) {
        logger.warn({ err }, 'Host resolveUser hook threw; falling back');
      }
    }

    let userId = hostResolved?.userId || 'default-user';
    let verified:
      | { userId: string; role?: string; organizationId?: string; studentId?: string }
      | null = null;

    if (bearer) {
      verified = await verifyUserToken(bearer, profile, cfg);
      if (verified) {
        userId = verified.userId;
      } else if (cfg.requireAuth || profile.auth.mode === 'jwt') {
        res.status(401).json({ error: 'Invalid or expired authentication token.' });
        return;
      }
    } else if (!hostResolved && (cfg.requireAuth || profile.auth.mode === 'jwt')) {
      res.status(401).json({ error: 'Missing Authorization Bearer token.' });
      return;
    }

    const headerUserId = req.header('x-user-id');
    if (!bearer && !hostResolved && headerUserId) {
      userId = headerUserId.trim().slice(0, 64) || 'default-user';
    }

    req.appProfile = profile;
    req.authUser = {
      userId,
      rawToken: bearer,
      role: hostResolved?.role || verified?.role,
      organizationId: hostResolved?.organizationId || verified?.organizationId,
      sectorIds:
        hostResolved?.sectorIds ||
        (hostResolved?.sectorId ? [hostResolved.sectorId] : undefined),
      studentId: hostResolved?.studentId || verified?.studentId,
      name: hostResolved?.name,
    };
    next();
  };
}
