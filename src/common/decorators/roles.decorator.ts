/**
 * @Roles() metadata decorator.
 *
 * Marks a route handler with the roles that are allowed to invoke it.
 * Consumed by RolesGuard after SessionGuard has resolved the user.
 *
 * Usage:
 *   @Roles('owner', 'admin')
 *   @Post()
 *   create(...) { ... }
 */

import { SetMetadata } from '@nestjs/common';
import type { UserRole } from './current-user.decorator';

export const ROLES_KEY = 'roles';

export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
