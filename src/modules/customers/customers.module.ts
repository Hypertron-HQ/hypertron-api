import { Module } from '@nestjs/common';
import { CustomersRepository } from './customers.repository';

@Module({
  providers: [CustomersRepository],
  exports: [CustomersRepository],
})
export class CustomersModule {}
