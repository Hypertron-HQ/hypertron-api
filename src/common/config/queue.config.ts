import { registerAs } from '@nestjs/config';

export interface QueueConfig {
  redisUrl: string;
}

export default registerAs(
  'queue',
  (): QueueConfig => ({
    redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  }),
);
