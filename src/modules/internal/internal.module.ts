import { Module } from '@nestjs/common';

import { MerchantSettingsController } from './merchant-settings.controller';

@Module({
  controllers: [MerchantSettingsController],
})
export class InternalModule {}
