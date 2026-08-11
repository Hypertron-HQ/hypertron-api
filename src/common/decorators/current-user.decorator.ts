/**
 * @CurrentUser() parameter decorator.
 *
 * Extracts the Freighter session user attached by `SessionGuard`.
 * Provides `{ walletAddress, businessId, role }`.
 */

import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

export type UserRole = 'owner' | 'admin' | 'viewer';

export interface SessionUser {
  /** Stellar G-address from Freighter ht_dashboard cookie */
  walletAddress: string;
  /** Core Business.id (cuid) for this wallet */
  businessId: string;
  /** RBAC role within the business (owner for Freighter v1) */
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
