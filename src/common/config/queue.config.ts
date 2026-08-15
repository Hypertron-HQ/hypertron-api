import { registerAs } from '@nestjs/config';

export interface QueueConfig {
  redisUrl: string;
  /** When true, skip BullMQ processors / cron schedulers (HTTP-only pods). */
  disableWorkers: boolean;
  /** When true, do not connect to Redis at all (no BullMQ, in-memory rate limits). */
  disableRedis: boolean;
}

export default registerAs('queue', (): QueueConfig => ({
  redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
  disableWorkers: workersDisabled(),
  disableRedis: redisDisabled(),
}));

/**
 * Skip Redis + BullMQ. Set DISABLE_REDIS=true until a Render Key Value
 * instance exists; then set DISABLE_REDIS=false and REDIS_URL=rediss://…
 */
export function redisDisabled(): boolean {
  return (
    process.env.DISABLE_REDIS === 'true' || process.env.NODE_ENV === 'test'
  );
}

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
    redisDisabled() ||
    process.env.DISABLE_WORKERS === 'true' ||
    process.env.NODE_ENV === 'test'
  );
}
