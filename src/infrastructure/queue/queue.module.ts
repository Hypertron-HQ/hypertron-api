/**
 * QueueModule — global BullMQ / Redis connection.
 *
 * When DISABLE_REDIS=true, BullMQ is not registered and the process never
 * opens a Redis socket. Webhook/reconciler enqueue calls no-op until Redis
 * is enabled.
 */

import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';

import type { QueueConfig } from '@/common/config/queue.config';
import { redisDisabled } from '@/common/config/queue.config';

const skipRedis = redisDisabled();

@Global()
@Module({
  imports: skipRedis
    ? []
    : [
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
  exports: skipRedis ? [] : [BullModule],
})
export class QueueModule {}
