/**
 * AuthModule — API key lifecycle and authentication.
 *
 * Exports:
 *  - ApiKeyService  → consumed by ApiKeyGuard and DeveloperModule
 *
 * Does NOT use @Global() — consumers import AuthModule explicitly.
 * ApiKeyGuard is exported for use as a guard in /v1 controllers.
 */

import { Module } from '@nestjs/common';
import { PrismaModule } from '@/infrastructure/prisma/prisma.module';
import { ApiKeyRepository } from './api-key.repository';
import { ApiKeyService } from './api-key.service';
import { ApiKeyGuard } from '@/common/guards/api-key.guard';

@Module({
  imports: [PrismaModule],
  providers: [ApiKeyRepository, ApiKeyService, ApiKeyGuard],
  exports: [ApiKeyService, ApiKeyGuard],
})
export class AuthModule {}
