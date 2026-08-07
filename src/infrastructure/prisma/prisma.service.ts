import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * PrismaService wraps PrismaClient and manages the connection lifecycle
 * with NestJS module hooks. Declared @Global so it is available throughout
 * the application without re-importing PrismaModule everywhere.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log: [
        { emit: 'stdout', level: 'error' },
        { emit: 'stdout', level: 'warn' },
      ],
    });
  }

  async onModuleInit(): Promise<void> {
    this.logger.log('Connecting to MongoDB...');
    await this.$connect();
    this.logger.log('MongoDB connection established');
  }

  async onModuleDestroy(): Promise<void> {
    this.logger.log('Disconnecting from MongoDB...');
    await this.$disconnect();
  }
}
