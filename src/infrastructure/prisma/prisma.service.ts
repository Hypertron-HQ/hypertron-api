import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { environmentScopeExtension } from './environment-scope.extension';

function createExtendedClient() {
  return new PrismaClient({
    log: [
      { emit: 'stdout', level: 'error' },
      { emit: 'stdout', level: 'warn' },
    ],
  }).$extends(environmentScopeExtension);
}

type ExtendedPrismaClient = ReturnType<typeof createExtendedClient>;

/** Interface merge — Nest injects PrismaService with full Prisma model surface. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type, @typescript-eslint/no-unsafe-declaration-merging -- intentional PrismaClient surface merge
export interface PrismaService extends ExtendedPrismaClient {}

/**
 * PrismaService — extended Prisma client with environment-scope guards (A6).
 *
 * Extended clients are proxies. Forward unknown properties to the extended
 * client so Prisma's non-enumerable methods (`$transaction`, `$runCommandRaw`,
 * etc.) remain available alongside model delegates and Nest lifecycle hooks.
 */
@Injectable()
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging -- intentional PrismaClient surface merge
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  private readonly client: ExtendedPrismaClient;

  constructor() {
    this.client = createExtendedClient();
    return new Proxy(this, {
      get: (target, property, receiver) => {
        if (Reflect.has(target, property)) {
          return Reflect.get(target, property, receiver);
        }
        // Extended Prisma client typing stops at the proxy boundary.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Reflect.get on extended client
        const value = Reflect.get(target.client, property);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call -- bind Prisma methods
        return typeof value === 'function' ? value.bind(target.client) : value;
      },
    });
  }

  async onModuleInit(): Promise<void> {
    this.logger.log('Connecting to MongoDB...');
    await this.client.$connect();
    this.logger.log('MongoDB connection established');
  }

  async onModuleDestroy(): Promise<void> {
    this.logger.log('Disconnecting from MongoDB...');
    await this.client.$disconnect();
  }
}
