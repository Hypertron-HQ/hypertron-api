/**
 * QueueModule — global BullMQ / Redis connection.
 *
 * Registers the shared connection used by reconciler (+ webhooks later).
 * When DISABLE_WORKERS=true, feature modules skip processor registration;
 * the connection is still available for enqueueing from HTTP pods.
 */

import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';

import type { QueueConfig } from '@/common/config/queue.config';

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const queue = config.get<QueueConfig>('queue')!;
        return {
          connection: {
            url: queue.redisUrl,
            maxRetriesPerRequest: null,
          },
        };
      },
    }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
