import { Module } from '@nestjs/common';

import { CheckoutLinksController } from './checkout-links.controller';

@Module({
  controllers: [CheckoutLinksController],
})
export class CheckoutLinksModule {}
