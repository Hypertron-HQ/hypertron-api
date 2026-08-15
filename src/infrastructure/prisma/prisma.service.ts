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
    await this.repairMongoIndexes();
    this.logger.log('MongoDB connection established');
  }

  async onModuleDestroy(): Promise<void> {
    this.logger.log('Disconnecting from MongoDB...');
    await this.client.$disconnect();
  }

  /**
   * Prisma cannot represent MongoDB partial indexes. Repair the two indexes
   * whose generated definitions break normal production flows:
   *
   * - multiple API keys per business/environment must be allowed;
   * - transactionHash must be unique only after it contains a string.
   *
   * This is idempotent and runs before Render starts accepting requests.
   */
  private async repairMongoIndexes(): Promise<void> {
    try {
      const obsoleteApiKeyIndex =
        'api_keys_businessId_environment_keyPrefix_key';
      if (
        await this.dropIndexIfPresent('api_keys', obsoleteApiKeyIndex)
      ) {
        this.logger.warn(
          `Dropped obsolete unique index ${obsoleteApiKeyIndex}`,
        );
      }

      const transactionIndexName = 'payments_transactionHash_key';
      try {
        await this.createTransactionHashIndex(transactionIndexName);
      } catch (error) {
        if (!isIndexOptionsConflict(error)) throw error;

        await this.dropIndexIfPresent('payments', transactionIndexName);
        this.logger.warn(
          `Dropped incompatible index ${transactionIndexName}`,
        );
        await this.createTransactionHashIndex(transactionIndexName);
        this.logger.log(
          `Created partial unique index ${transactionIndexName}`,
        );
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown index repair error';
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(`MongoDB index repair failed: ${message}`, stack);
      throw error;
    }
  }

  private async createTransactionHashIndex(name: string): Promise<void> {
    await this.client.$runCommandRaw({
      createIndexes: 'payments',
      indexes: [
        {
          key: { transactionHash: 1 },
          name,
          unique: true,
          partialFilterExpression: {
            transactionHash: { $type: 'string' },
          },
        },
      ],
    });
  }

  private async dropIndexIfPresent(
    collection: string,
    name: string,
  ): Promise<boolean> {
    try {
      await this.client.$runCommandRaw({
        dropIndexes: collection,
        index: name,
      });
      return true;
    } catch (error) {
      if (isIndexNotFound(error)) return false;
      throw error;
    }
  }
}

function mongoErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const record = error as {
    message?: unknown;
    meta?: { code?: unknown; message?: unknown };
  };
  return [record.meta?.code, record.meta?.message, record.message]
    .filter((value) => value !== undefined)
    .map(String)
    .join(' ');
}

function isIndexNotFound(error: unknown): boolean {
  const text = mongoErrorCode(error);
  return /\b27\b|IndexNotFound|index not found/i.test(text);
}

function isIndexOptionsConflict(error: unknown): boolean {
  const text = mongoErrorCode(error);
  return (
    /\b85\b|\b86\b|IndexOptionsConflict|IndexKeySpecsConflict|already exists with a different/i.test(
      text,
    )
  );
}
