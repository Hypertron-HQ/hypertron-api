import { Module } from '@nestjs/common';
import { AuthModule } from '@/modules/auth/auth.module';
import { CustomersModule } from '@/modules/customers/customers.module';
import { PrismaModule } from '@/infrastructure/prisma/prisma.module';
import { WebhooksModule } from '@/modules/webhooks/webhooks.module';
import { SessionGuard } from '@/common/guards/session.guard';
import { RolesGuard } from '@/common/guards/roles.guard';
import { ApiKeysController } from './api-keys.controller';
import { DeveloperCustomersController } from './customers-dashboard.controller';
import { WebhookEndpointsController } from './webhook-endpoints.controller';

@Module({
  imports: [AuthModule, CustomersModule, PrismaModule, WebhooksModule],
  controllers: [
    ApiKeysController,
    DeveloperCustomersController,
    WebhookEndpointsController,
  ],
  providers: [SessionGuard, RolesGuard],
})
export class DeveloperModule {}
