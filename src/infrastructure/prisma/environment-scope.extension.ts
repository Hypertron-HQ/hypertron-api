/**
 * Prisma client extension: enforce test/live isolation on env-scoped models.
 *
 * Rules:
 *  - create: data.environment required
 *  - find/update/delete: if where includes businessId (merchant scope),
 *    environment is required unless the query includes a globally unique
 *    publicId. Dashboard lists may explicitly request both environments.
 *
 * Worker queries that intentionally scan all environments (e.g. reconciler
 * pending poll by status only) omit businessId and are allowed.
 */

import { Prisma } from '@prisma/client';

const ENV_SCOPED_MODELS = new Set([
  'Payment',
  'ApiKey',
  'CheckoutLink',
  'WebhookEndpoint',
]);

export class MissingEnvironmentError extends Error {
  constructor(model: string, operation: string) {
    super(
      `${model}.${operation} requires environment when scoped by businessId (test|live isolation)`,
    );
    this.name = 'MissingEnvironmentError';
  }
}

function hasEnvironment(obj: unknown): boolean {
  if (!obj || typeof obj !== 'object') return false;
  const env = (obj as { environment?: unknown }).environment;
  if (env === 'test' || env === 'live') return true;
  if (!env || typeof env !== 'object') return false;

  const values = (env as { in?: unknown }).in;
  return (
    Array.isArray(values) &&
    values.length > 0 &&
    values.every((value) => value === 'test' || value === 'live')
  );
}

function hasBusinessId(obj: unknown): boolean {
  if (!obj || typeof obj !== 'object') return false;
  return 'businessId' in obj;
}

function hasUniquePublicId(obj: unknown): boolean {
  if (!obj || typeof obj !== 'object') return false;
  return typeof (obj as { publicId?: unknown }).publicId === 'string';
}

export function assertEnvironmentScope(
  model: string,
  operation: string,
  args: { where?: unknown; data?: unknown },
): void {
  if (!ENV_SCOPED_MODELS.has(model)) return;

  if (operation === 'create') {
    if (!hasEnvironment(args.data)) {
      throw new MissingEnvironmentError(model, operation);
    }
    return;
  }

  if (
    hasBusinessId(args.where) &&
    !hasEnvironment(args.where) &&
    !hasUniquePublicId(args.where)
  ) {
    throw new MissingEnvironmentError(model, operation);
  }
}

export const environmentScopeExtension = Prisma.defineExtension({
  name: 'environment-scope',
  query: {
    $allModels: {
      async findMany({ model, operation, args, query }) {
        assertEnvironmentScope(model, operation, args);
        return query(args);
      },
      async findFirst({ model, operation, args, query }) {
        assertEnvironmentScope(model, operation, args);
        return query(args);
      },
      async findUnique({ model, operation, args, query }) {
        assertEnvironmentScope(model, operation, args);
        return query(args);
      },
      async create({ model, operation, args, query }) {
        assertEnvironmentScope(model, operation, args);
        return query(args);
      },
      async update({ model, operation, args, query }) {
        assertEnvironmentScope(model, operation, args);
        return query(args);
      },
      async updateMany({ model, operation, args, query }) {
        assertEnvironmentScope(model, operation, args);
        return query(args);
      },
      async delete({ model, operation, args, query }) {
        assertEnvironmentScope(model, operation, args);
        return query(args);
      },
      async deleteMany({ model, operation, args, query }) {
        assertEnvironmentScope(model, operation, args);
        return query(args);
      },
    },
  },
});
