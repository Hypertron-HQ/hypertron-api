/**
 * @CurrentUser() parameter decorator.
 *
 * Extracts the session user context attached to the request by `SessionGuard`.
 * Provides `{ userId, businessId, role }`.
 *
 * Usage:
 *   @Get()
 *   list(@CurrentUser() user: SessionUser) { ... }
 */

import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

export type UserRole = 'owner' | 'admin' | 'viewer';

export interface SessionUser {
  /** Privy DID or internal user ID */
  userId: string;
  /** Business (merchant) this user belongs to */
  businessId: string;
  /** RBAC role within the business */
  role: UserRole;
}

/** The property name used to store the session user on the request object. */
export const SESSION_USER_KEY = 'user';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): SessionUser => {
    const request = ctx
      .switchToHttp()
      .getRequest<Request & { [SESSION_USER_KEY]: SessionUser }>();
    return request[SESSION_USER_KEY];
  },
);
