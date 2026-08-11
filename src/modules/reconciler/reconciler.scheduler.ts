/**
 * Registers BullMQ job schedulers for reconciler + expiry crons on boot.
 * Skipped when DISABLE_WORKERS=true.
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

import type { QueueConfig } from '@/common/config/queue.config';
import {
  RECONCILER_QUEUE,
  EXPIRY_QUEUE,
  JOB_POLL_OPEN,
  JOB_EXPIRE_OVERDUE,
  SCHEDULER_POLL_OPEN,
  SCHEDULER_EXPIRE,
} from './reconciler.constants';

@Injectable()
export class ReconcilerScheduler implements OnModuleInit {
  private readonly logger = new Logger(ReconcilerScheduler.name);

  constructor(
    @InjectQueue(RECONCILER_QUEUE) private readonly reconcilerQueue: Queue,
    @InjectQueue(EXPIRY_QUEUE) private readonly expiryQueue: Queue,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    const queueCfg = this.config.get<QueueConfig>('queue');
    if (queueCfg?.disableWorkers) {
      this.logger.log('DISABLE_WORKERS=true — skipping reconciler schedulers');
      return;
    }

    await this.reconcilerQueue.upsertJobScheduler(
      SCHEDULER_POLL_OPEN,
      { every: 30_000 },
      {
        name: JOB_POLL_OPEN,
        opts: {
          removeOnComplete: true,
          removeOnFail: 50,
        },
      },
    );

    await this.expiryQueue.upsertJobScheduler(
      SCHEDULER_EXPIRE,
      { every: 60_000 },
      {
        name: JOB_EXPIRE_OVERDUE,
        opts: {
          removeOnComplete: true,
          removeOnFail: 50,
        },
      },
    );

    this.logger.log(
      'Registered reconciler schedulers (poll 30s, expiry 60s)',
    );
  }
}
