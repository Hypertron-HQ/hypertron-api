import { Module } from '@nestjs/common';
import { AuthModule } from '@/modules/auth/auth.module';
import { IdempotencyModule } from '@/modules/idempotency/idempotency.module';
import { CustomersModule } from '@/modules/customers/customers.module';
import { EventsModule } from '@/modules/events/events.module';

import { PaymentsRepository } from './payments.repository';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import { PaymentStateMachine } from './payment-state-machine';

@Module({
  imports: [AuthModule, IdempotencyModule, CustomersModule, EventsModule],
  providers: [PaymentsRepository, PaymentsService, PaymentStateMachine],
  controllers: [PaymentsController],
  exports: [PaymentsService, PaymentStateMachine],
})
export class PaymentsModule {}
