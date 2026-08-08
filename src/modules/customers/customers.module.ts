import { Module } from '@nestjs/common';
import { AuthModule } from '@/modules/auth/auth.module';
import { CustomersRepository } from './customers.repository';
import { CustomersService } from './customers.service';
import { CustomersController } from './customers.controller';

@Module({
  imports: [AuthModule],
  providers: [CustomersRepository, CustomersService],
  controllers: [CustomersController],
  exports: [CustomersRepository, CustomersService],
})
export class CustomersModule {}
