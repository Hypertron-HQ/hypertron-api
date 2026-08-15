import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';

import { PaymentsModule } from '@/modules/payments/payments.module';
import { EventsModule } from '@/modules/events/events.module';
import { CustomersModule } from '@/modules/customers/customers.module';
import { StellarModule } from '@/infrastructure/stellar/stellar.module';
import { workersDisabled, redisDisabled } from '@/common/config/queue.config';

import { StellarVerifier } from './stellar-verifier';
import { ReconcilerService } from './reconciler.service';
import { ReconcilerProcessor } from './reconciler.processor';
import { ExpiryProcessor } from './expiry.processor';
import { ReconcilerScheduler } from './reconciler.scheduler';
import { RECONCILER_QUEUE, EXPIRY_QUEUE } from './reconciler.constants';

const skipQueues = redisDisabled();
const disableWorkers = workersDisabled();

@Module({
  imports: [
    StellarModule,
    PaymentsModule,
    EventsModule,
    CustomersModule,
    ...(skipQueues
      ? []
      : [
          BullModule.registerQueue(
            { name: RECONCILER_QUEUE },
            { name: EXPIRY_QUEUE },
          ),
        ]),
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
