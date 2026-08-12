import { Global, Module } from '@nestjs/common';
import { StellarHorizonService } from './stellar-horizon.service';

@Global()
@Module({
  providers: [StellarHorizonService],
  exports: [StellarHorizonService],
})
export class StellarModule {}
