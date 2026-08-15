import { Global, Module } from '@nestjs/common';

import { CoreBackendClient } from './core-backend.client';

@Global()
@Module({
  providers: [CoreBackendClient],
  exports: [CoreBackendClient],
})
export class CoreBackendModule {}
