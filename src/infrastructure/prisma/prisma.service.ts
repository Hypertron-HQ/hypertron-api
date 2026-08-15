import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { MongoClient, type Db, type IndexDescriptionInfo } from 'mongodb';

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
    // Render sends SIGTERM to the old instance during deploys and hibernation.
    // This is expected graceful shutdown, not a database failure.
    this.logger.log('Graceful shutdown: disconnecting from MongoDB...');
    await this.client.$disconnect();
    this.logger.log('Graceful shutdown: MongoDB disconnected cleanly');
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
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('DATABASE_URL is required for MongoDB index repair');
    }

    // Prisma's raw-command decoder cannot reliably inspect listIndexes output
    // from every MongoDB version. A short-lived native client lets us inspect
    // first and mutate only when needed, avoiding expected error-level logs.
    const mongoClient = new MongoClient(databaseUrl);

    try {
      await mongoClient.connect();
      const database = mongoClient.db();
      const obsoleteApiKeyIndex =
        'api_keys_businessId_environment_keyPrefix_key';
      if (
        await this.dropIndexIfPresent(database, 'api_keys', obsoleteApiKeyIndex)
      ) {
        this.logger.warn(
          `Dropped obsolete unique index ${obsoleteApiKeyIndex}`,
        );
      }

      const transactionIndexName = 'payments_transactionHash_key';
      const payments = database.collection('payments');
      const indexes = await this.listIndexesIfCollectionExists(
        database,
        'payments',
      );
      let hasDesiredTransactionHashIndex = false;

      for (const index of indexes.filter(isTransactionHashIndex)) {
        if (isDesiredTransactionHashIndex(index)) {
          hasDesiredTransactionHashIndex = true;
          continue;
        }

        if (index.name) {
          await payments.dropIndex(index.name);
          this.logger.warn(`Dropped incompatible index ${index.name}`);
        }
      }

      if (!hasDesiredTransactionHashIndex) {
        await payments.createIndex(
          { transactionHash: 1 },
          {
            name: transactionIndexName,
            unique: true,
            partialFilterExpression: {
              transactionHash: { $type: 'string' },
            },
          },
        );
        this.logger.log(`Created partial unique index ${transactionIndexName}`);
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown index repair error';
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(`MongoDB index repair failed: ${message}`, stack);
      throw error;
    } finally {
      await mongoClient.close();
    }
  }

  private async listIndexesIfCollectionExists(
    database: Db,
    collection: string,
  ): Promise<IndexDescriptionInfo[]> {
    const exists = await database
      .listCollections({ name: collection }, { nameOnly: true })
      .hasNext();
    if (!exists) return [];

    const indexes = (await database
      .collection(collection)
      .listIndexes()
      .toArray()) as IndexDescriptionInfo[];
    return indexes;
  }

  private async dropIndexIfPresent(
    database: Db,
    collection: string,
    name: string,
  ): Promise<boolean> {
    try {
      await database.collection(collection).dropIndex(name);
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
    code?: unknown;
    codeName?: unknown;
    message?: unknown;
    meta?: { code?: unknown; message?: unknown };
  };
  return [
    record.code,
    record.codeName,
    record.meta?.code,
    record.meta?.message,
    record.message,
  ]
    .filter((value) => value !== undefined)
    .map(String)
    .join(' ');
}

function isIndexNotFound(error: unknown): boolean {
  const text = mongoErrorCode(error);
  return /\b26\b|\b27\b|NamespaceNotFound|IndexNotFound|index not found/i.test(
    text,
  );
}

function isTransactionHashIndex(index: IndexDescriptionInfo): boolean {
  const entries = Object.entries(index.key ?? {});
  return (
    entries.length === 1 &&
    entries[0][0] === 'transactionHash' &&
    entries[0][1] === 1
  );
}

function isDesiredTransactionHashIndex(index: IndexDescriptionInfo): boolean {
  const partial = index.partialFilterExpression as
    { transactionHash?: { $type?: unknown } } | undefined;
  return index.unique === true && partial?.transactionHash?.$type === 'string';
}
