/**
 * DeveloperModule — /api/developer/* dashboard control-plane.
 *
 * Phase 3 scope: API key management (4 routes).
 * Webhook endpoints and customer dashboard routes are Phase 7/5 respectively.
 *
 * Dependencies:
 *  - AuthModule (exports ApiKeyService)
 *  - SessionGuard + RolesGuard declared here (they depend on ConfigService
 *    which is global, and Reflector which NestJS provides automatically)
 */

import { Module } from '@nestjs/common';
import { AuthModule } from '@/modules/auth/auth.module';
import { SessionGuard } from '@/common/guards/session.guard';
import { RolesGuard } from '@/common/guards/roles.guard';
import { ApiKeysController } from './api-keys.controller';

@Module({
  imports: [AuthModule],
  controllers: [ApiKeysController],
  providers: [SessionGuard, RolesGuard],
})
export class DeveloperModule {}
