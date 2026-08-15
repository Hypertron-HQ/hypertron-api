import { registerAs } from '@nestjs/config';

export interface QueueConfig {
  redisUrl: string;
  /** When true, skip BullMQ processors / cron schedulers (HTTP-only pods). */
  disableWorkers: boolean;
}

export default registerAs('queue', (): QueueConfig => ({
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  disableWorkers: workersDisabled(),
}));

/**
 * Whether BullMQ processors should be registered in this process.
 *
 * Evaluated at module definition time (processors are static providers), so it
 * reads the environment directly rather than going through ConfigService.
 * Test runs never start workers — a BullMQ Worker demands a live Redis
 * connection the moment it is constructed.
 */
export function workersDisabled(): boolean {
  return (
    process.env.DISABLE_WORKERS === 'true' || process.env.NODE_ENV === 'test'
  );
}
