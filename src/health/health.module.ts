import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { RootController } from './root.controller';
import { CoreBackendModule } from '../infrastructure/core-backend/core-backend.module';

@Module({
  imports: [TerminusModule, CoreBackendModule],
  controllers: [HealthController, RootController],
})
export class HealthModule {}
