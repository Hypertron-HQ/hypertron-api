import { registerAs } from '@nestjs/config';

export interface QueueConfig {
  redisUrl: string;
  /** When true, skip BullMQ processors / cron schedulers (HTTP-only pods). */
  disableWorkers: boolean;
}

export default registerAs('queue', (): QueueConfig => ({
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  disableWorkers: process.env.DISABLE_WORKERS === 'true',
}));
