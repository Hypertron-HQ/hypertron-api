/**
 * RateLimitModule — exports HypertronThrottlerGuard for feature controllers.
 *
 * ThrottlerModule.forRootAsync is registered in AppModule; this module only
 * re-exports the configured ThrottlerModule + our keyed guard.
 */

import { Global, Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';

import { HypertronThrottlerGuard } from '@/common/guards/hypertron-throttler.guard';

@Global()
@Module({
  imports: [ThrottlerModule],
  providers: [HypertronThrottlerGuard],
  exports: [ThrottlerModule, HypertronThrottlerGuard],
})
export class RateLimitModule {}
