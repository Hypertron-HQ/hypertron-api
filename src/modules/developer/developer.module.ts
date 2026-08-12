import { Module } from '@nestjs/common';
import { AuthModule } from '@/modules/auth/auth.module';
import { CustomersModule } from '@/modules/customers/customers.module';
import { PrismaModule } from '@/infrastructure/prisma/prisma.module';
import { SessionGuard } from '@/common/guards/session.guard';
import { RolesGuard } from '@/common/guards/roles.guard';
import { ApiKeysController } from './api-keys.controller';
import { DeveloperCustomersController } from './customers-dashboard.controller';

@Module({
  imports: [AuthModule, CustomersModule, PrismaModule],
  controllers: [ApiKeysController, DeveloperCustomersController],
  providers: [SessionGuard, RolesGuard],
})
export class DeveloperModule {}
