import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';

import { PaymentsModule } from '@/modules/payments/payments.module';
import { EventsModule } from '@/modules/events/events.module';
import { CustomersModule } from '@/modules/customers/customers.module';
import { StellarModule } from '@/infrastructure/stellar/stellar.module';

import { StellarVerifier } from './stellar-verifier';
import { ReconcilerService } from './reconciler.service';
import { ReconcilerProcessor } from './reconciler.processor';
import { ExpiryProcessor } from './expiry.processor';
import { ReconcilerScheduler } from './reconciler.scheduler';
import { RECONCILER_QUEUE, EXPIRY_QUEUE } from './reconciler.constants';

const disableWorkers = process.env.DISABLE_WORKERS === 'true';

@Module({
  imports: [
    StellarModule,
    PaymentsModule,
    EventsModule,
    CustomersModule,
    BullModule.registerQueue(
      { name: RECONCILER_QUEUE },
      { name: EXPIRY_QUEUE },
    ),
  ],
  providers: [
    StellarVerifier,
    ReconcilerService,
    ...(disableWorkers
      ? []
      : [ReconcilerProcessor, ExpiryProcessor, ReconcilerScheduler]),
  ],
  exports: [ReconcilerService, StellarVerifier],
})
export class ReconcilerModule {}
