import jwt from 'jsonwebtoken';
import type { AuthedRequest } from '../auth.ts';
import type { ServerConfig } from '../config.ts';

export type ScopeRole =
  | 'PUBLIC'
  | 'USER'
  | 'STUDENT'
  | 'MANAGER'
  | 'SECTOR_MANAGER'
  | 'ADMIN'
  | 'SUPER_ADMIN';

export type AccessScope =
  | { role: 'PUBLIC'; userId: string }
  | {
      role: 'STUDENT' | 'USER';
      userId: string;
      studentId: string;
      organizationId?: string;
      sectorId?: string;
      name?: string;
    }
  | {
      role: 'SECTOR_MANAGER' | 'MANAGER';
      userId: string;
      organizationId: string;
      sectorIds: string[];
      name?: string;
    }
  | {
      role: 'ADMIN';
      userId: string;
      organizationId: string;
      sectorId?: string;
      name?: string;
    }
  | {
      role: 'SUPER_ADMIN';
      userId: string;
      organizationId?: string;
      name?: string;
    };

export interface VerifiedSessionContext {
  userId: string;
  role: string;
  organizationId?: string;
  sectorId?: string;
  sectorIds?: string[];
  studentId?: string;
  name?: string;
}

export function normalizeRole(raw: string | undefined): ScopeRole {
  const upper = String(raw || '').trim().toUpperCase();
  if (upper === 'SUPER_ADMIN' || upper === 'SUPERADMIN') return 'SUPER_ADMIN';
  if (upper === 'ADMIN' || upper === 'OWNER') return 'ADMIN';
  if (upper === 'SECTOR_MANAGER') return 'SECTOR_MANAGER';
  if (upper === 'MANAGER') return 'MANAGER';
  if (upper === 'STUDENT') return 'STUDENT';
  if (upper === 'USER' || upper === 'MEMBER') return 'USER';
  return 'PUBLIC';
}

function tryDecodeJwtToken(
  token: string,
  secret: string
): VerifiedSessionContext | null {
  if (!token || !token.includes('.')) return null;
  try {
    const decoded = jwt.verify(token, secret) as Record<string, unknown>;
    if (!decoded || typeof decoded !== 'object') return null;
    const role = String(decoded.role || '').trim();
    if (!role) return null;
    return {
      userId: String(decoded.userId || decoded.sub || decoded.id || 'user'),
      role,
      organizationId:
        typeof decoded.organizationId === 'string'
          ? decoded.organizationId
          : typeof decoded.orgId === 'string'
            ? decoded.orgId
            : undefined,
      sectorId: typeof decoded.sectorId === 'string' ? decoded.sectorId : undefined,
      sectorIds: Array.isArray(decoded.sectorIds)
        ? decoded.sectorIds.map(String)
        : typeof decoded.sectorId === 'string'
          ? [decoded.sectorId]
          : undefined,
      studentId:
        typeof decoded.studentId === 'string'
          ? decoded.studentId
          : typeof decoded.admissionNo === 'string'
            ? decoded.admissionNo
            : undefined,
      name: typeof decoded.name === 'string' ? decoded.name : undefined,
    };
  } catch {
    return null;
  }
}

export function buildScopeFromSession(session: VerifiedSessionContext): AccessScope {
  const role = normalizeRole(session.role);
  const userId = String(session.userId || 'user');
  const organizationId = String(session.organizationId || 'default');
  const sectorIds = Array.isArray(session.sectorIds)
    ? session.sectorIds.map(String).filter(Boolean)
    : session.sectorId
      ? [String(session.sectorId)]
      : [];

  if (role === 'SUPER_ADMIN') {
    return { role: 'SUPER_ADMIN', userId, organizationId: session.organizationId, name: session.name };
  }
  if (role === 'ADMIN') {
    return {
      role: 'ADMIN',
      userId,
      organizationId,
      sectorId: sectorIds[0],
      name: session.name,
    };
  }
  if (role === 'SECTOR_MANAGER' || role === 'MANAGER') {
    return {
      role,
      userId,
      organizationId,
      sectorIds,
      name: session.name,
    };
  }
  if (role === 'STUDENT' || role === 'USER') {
    return {
      role,
      userId,
      studentId: String(session.studentId || userId),
      organizationId,
      sectorId: sectorIds[0],
      name: session.name,
    };
  }
  return { role: 'PUBLIC', userId: 'guest' };
}

export async function extractAccessScope(
  req: AuthedRequest,
  cfg: ServerConfig,
  opts?: {
    defaultUnauthenticatedRole?: 'PUBLIC' | 'ADMIN' | 'USER';
    ignoreBodyAppState?: boolean;
  }
): Promise<AccessScope> {
  if (req.resolvedScope) {
    return req.resolvedScope;
  }

  // 1. Host-resolved user from createAuthMiddleware (`resolveUser` hook)
  if (req.authUser?.role) {
    const scope = buildScopeFromSession({
      userId: req.authUser.userId,
      role: req.authUser.role,
      organizationId: req.authUser.organizationId,
      sectorIds: req.authUser.sectorIds,
      studentId: req.authUser.studentId,
      name: req.authUser.name,
    });
    req.resolvedScope = scope;
    return scope;
  }

  // 2. Signed Bearer JWT
  const authHeader = req.header('authorization') || '';
  const bearer = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : '';
  if (bearer) {
    const jwtSession = tryDecodeJwtToken(bearer, cfg.authSecret);
    if (jwtSession) {
      const scope = buildScopeFromSession(jwtSession);
      req.resolvedScope = scope;
      return scope;
    }
  }

  // 3. Explicit scope headers (safe for host gateways / dev proxies)
  const headerRole = req.header('x-user-role');
  if (headerRole) {
    const headerSector = req.header('x-sector-ids') || req.header('x-sector-id') || '';
    const scope = buildScopeFromSession({
      userId: req.header('x-user-id') || req.authUser?.userId || 'user',
      role: headerRole,
      organizationId: req.header('x-org-id') || req.header('x-organization-id') || 'default',
      sectorIds: headerSector
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      studentId: req.header('x-student-id') || undefined,
    });
    req.resolvedScope = scope;
    return scope;
  }

  // 4. Optional route awareness from appState (respects explicit /login /signup routes as PUBLIC)
  if (!opts?.ignoreBodyAppState && req.body && typeof req.body === 'object') {
    const appState = (req.body as { appState?: Record<string, unknown> }).appState;
    const pathname = typeof appState?.pathname === 'string' ? appState.pathname : '';
    if (/^\/(login|signin|sign-in|signup|sign-up|auth)(?:\/|$)/i.test(pathname)) {
      const scope: AccessScope = { role: 'PUBLIC', userId: 'guest' };
      req.resolvedScope = scope;
      return scope;
    }
    const currentRole = typeof appState?.currentRole === 'string' ? appState.currentRole : '';
    if (currentRole) {
      const scope = buildScopeFromSession({
        userId: typeof appState?.userId === 'string' ? appState.userId : req.authUser?.userId || 'default-user',
        role: currentRole,
        organizationId:
          typeof appState?.organizationId === 'string' ? appState.organizationId : 'default',
        sectorId: typeof appState?.sectorId === 'string' ? appState.sectorId : undefined,
        studentId: typeof appState?.studentId === 'string' ? appState.studentId : undefined,
      });
      req.resolvedScope = scope;
      return scope;
    }
  }

  // 5. Zero-config default: ADMIN in disabled-auth/disabled-billing mode, or PUBLIC when auth required
  const fallbackRole =
    opts?.defaultUnauthenticatedRole ?? (cfg.requireAuth ? 'PUBLIC' : 'ADMIN');
  if (fallbackRole === 'PUBLIC') {
    return { role: 'PUBLIC', userId: 'guest' };
  }
  return {
    role: fallbackRole,
    userId: req.authUser?.userId || 'default-user',
    ...(fallbackRole === 'ADMIN'
      ? { organizationId: req.authUser?.organizationId || 'default' }
      : {
          studentId: req.authUser?.userId || 'default-user',
          organizationId: req.authUser?.organizationId || 'default',
        }),
  } as AccessScope;
}

export function getScopeOrganizationId(scope?: AccessScope): string | undefined {
  if (!scope || scope.role === 'PUBLIC') return undefined;
  return 'organizationId' in scope ? scope.organizationId : undefined;
}

export function isAllowedOrganization(scope: AccessScope, targetOrgId: string | undefined): boolean {
  if (!targetOrgId) return true;
  if (scope.role === 'SUPER_ADMIN') return true;
  if (scope.role === 'PUBLIC') return false;
  if ('organizationId' in scope && scope.organizationId) {
    return scope.organizationId === targetOrgId;
  }
  return true;
}

export function canAccessSector(scope: AccessScope, sectorId: string | undefined): boolean {
  if (!sectorId) return true;
  if (scope.role === 'SUPER_ADMIN' || scope.role === 'ADMIN') return true;
  if (scope.role === 'SECTOR_MANAGER' || scope.role === 'MANAGER') {
    return scope.sectorIds.some((s) => s.toLowerCase() === sectorId.toLowerCase());
  }
  if ((scope.role === 'STUDENT' || scope.role === 'USER') && scope.sectorId) {
    return scope.sectorId.toLowerCase() === sectorId.toLowerCase();
  }
  return scope.role !== 'PUBLIC';
}

export function canAccessStudent(
  scope: AccessScope,
  studentId: string | undefined,
  studentSectorId?: string
): boolean {
  if (scope.role === 'SUPER_ADMIN' || scope.role === 'ADMIN') return true;
  if (scope.role === 'SECTOR_MANAGER' || scope.role === 'MANAGER') {
    if (!studentSectorId) return true;
    return canAccessSector(scope, studentSectorId);
  }
  if (scope.role === 'STUDENT' || scope.role === 'USER') {
    if (!studentId) return true;
    return scope.studentId.toLowerCase() === studentId.toLowerCase();
  }
  return false;
}

export function getAllowedSectorsForScope(scope: AccessScope): string[] | null {
  if (scope.role === 'SUPER_ADMIN' || scope.role === 'ADMIN') return null;
  if (scope.role === 'SECTOR_MANAGER' || scope.role === 'MANAGER') {
    return [...scope.sectorIds];
  }
  if ((scope.role === 'STUDENT' || scope.role === 'USER') && scope.sectorId) {
    return [scope.sectorId];
  }
  return [];
}

export function describeAccessDenied(scope: AccessScope, resourceName: string): string {
  if (scope.role === 'PUBLIC') {
    return `Access denied: Please sign in before accessing ${resourceName}.`;
  }
  if (scope.role === 'STUDENT' || scope.role === 'USER') {
    return `Access denied: Your role (${scope.role}) only permits accessing your own ${resourceName}.`;
  }
  if (scope.role === 'SECTOR_MANAGER' || scope.role === 'MANAGER') {
    return `Access denied: Your role only permits managing your assigned scope (${scope.sectorIds.join(', ') || 'none'}).`;
  }
  return `Access denied for ${resourceName}.`;
}
