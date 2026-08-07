/**
 * RolesGuard — RBAC enforcement for /api/developer/* routes.
 *
 * Must run after SessionGuard (which populates request.user).
 * Reads `@Roles(...)` metadata from the handler and compares against
 * the resolved `user.role`.
 *
 * If no `@Roles()` decorator is present, the route is accessible to any
 * authenticated session (all roles pass).
 *
 * Returns 403 PermissionException when the role is insufficient.
 */

import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { ROLES_KEY } from '@/common/decorators/roles.decorator';
import { PermissionException } from '@/common/exceptions/hypertron.exception';
import {
  SESSION_USER_KEY,
  type SessionUser,
  type UserRole,
} from '@/common/decorators/current-user.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Read required roles from handler metadata (set by @Roles decorator)
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    // No @Roles decorator — any authenticated user may proceed
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<Request & { [SESSION_USER_KEY]: SessionUser }>();

    const user = request[SESSION_USER_KEY];

    // SessionGuard should have run first; guard against missing context
    if (!user) {
      throw new PermissionException(
        'permission_denied',
        'You do not have permission to perform this action.',
      );
    }

    if (!requiredRoles.includes(user.role)) {
      throw new PermissionException(
        'insufficient_role',
        `This action requires one of the following roles: ${requiredRoles.join(', ')}.`,
      );
    }

    return true;
  }
}
