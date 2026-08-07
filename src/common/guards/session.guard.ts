/**
 * SessionGuard — authenticates all /api/developer/* routes via session token.
 *
 * Token format: `Bearer <base64url-encoded JSON payload>`
 *
 * In production this delegates to Privy's JWT verification. For now it
 * validates a signed token containing `{ userId, businessId, role }`.
 *
 * The token is expected in the `Authorization: Bearer <token>` header.
 * Attaches `{ userId, businessId, role }` to `request.user`.
 *
 * Design notes (spec section 9.3):
 *  - Privy integration is a drop-in replacement — swap `validateToken()` only
 *  - Missing/invalid token → 401 authentication_error
 *  - The guard itself does NOT check roles — that is RolesGuard's job
 */

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

import { AuthenticationException } from '@/common/exceptions/hypertron.exception';
import {
  SESSION_USER_KEY,
  type SessionUser,
} from '@/common/decorators/current-user.decorator';

@Injectable()
export class SessionGuard implements CanActivate {
  private readonly logger = new Logger(SessionGuard.name);

  constructor(private readonly config: ConfigService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { [SESSION_USER_KEY]: SessionUser }>();

    const token = this.extractBearerToken(request);

    if (!token) {
      throw new AuthenticationException(
        'missing_session_token',
        'No session token provided. Include your token in the Authorization header.',
      );
    }

    const user = await this.validateToken(token);

    if (!user) {
      this.logger.warn('Session token validation failed');
      throw new AuthenticationException(
        'invalid_session_token',
        'The session token is invalid or has expired.',
      );
    }

    request[SESSION_USER_KEY] = user;
    return true;
  }

  /**
   * Validates the bearer token and extracts session user context.
   *
   * Current implementation: decodes a base64url JSON payload.
   * This is intentionally simple for development — swap for Privy JWT
   * verification in production by replacing this method only.
   *
   * A production implementation would:
   *  1. Verify the JWT signature against Privy's JWKS endpoint
   *  2. Check `exp` / `iat` claims
   *  3. Extract `userId` from the Privy `sub` claim
   *  4. Resolve `businessId` and `role` from the database
   */
  private async validateToken(token: string): Promise<SessionUser | null> {
    try {
      // Decode base64url-encoded JSON payload
      const json = Buffer.from(token, 'base64url').toString('utf8');
      const payload = JSON.parse(json) as Partial<SessionUser>;

      if (
        typeof payload.userId !== 'string' ||
        typeof payload.businessId !== 'string' ||
        (payload.role !== 'owner' &&
          payload.role !== 'admin' &&
          payload.role !== 'viewer')
      ) {
        return null;
      }

      return {
        userId: payload.userId,
        businessId: payload.businessId,
        role: payload.role,
      };
    } catch {
      return null;
    }
  }

  private extractBearerToken(request: Request): string | null {
    const authHeader = request.headers['authorization'];
    if (!authHeader || typeof authHeader !== 'string') return null;
    const [scheme, token] = authHeader.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token?.trim()) return null;
    return token.trim();
  }
}

/**
 * Generates a test session token for use in tests and local development.
 * Never use this in production — it produces unsigned tokens.
 */
export function generateTestSessionToken(user: SessionUser): string {
  return Buffer.from(JSON.stringify(user), 'utf8').toString('base64url');
}
