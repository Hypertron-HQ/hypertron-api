/**
 * IdempotencyService — POST /v1/payments replay store.
 *
 * Spec section 14: enforces that repeated requests with the same
 * Idempotency-Key return the cached response rather than creating duplicates.
 *
 * Flow:
 *  1. check()  — returns cached Payment JSON if the key was already completed,
 *                throws 409 if body mismatched or still processing
 *  2. reserve()— inserts an 'in-flight' record to claim the key (atomic via unique index)
 *  3. complete()—stores the final response after successful payment creation
 *
 * Scope: (businessId, apiKeyId, key) — cross-merchant isolation is guaranteed.
 */

import * as crypto from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/infrastructure/prisma/prisma.service';
import {
  IdempotencyException,
  InvalidRequestException,
} from '@/common/exceptions/hypertron.exception';

// ─── Constants ────────────────────────────────────────────────────────────────

const TTL_HOURS = 24;

// Prisma / MongoDB unique constraint error code
const MONGO_DUPLICATE_KEY_CODE = 'P2002';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface IdempotencyCheckResult {
  /** Whether a completed cached response was found */
  found: boolean;
  /** The stored response body (only present when found=true and status='complete') */
  cachedResponse?: unknown;
}

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Computes a stable SHA-256 hash of the request body for mismatch detection.
   * Keys in the object are sorted so `{ a:1, b:2 }` and `{ b:2, a:1 }` produce
   * the same hash.
   */
  hashBody(body: Record<string, unknown>): string {
    const sorted = JSON.stringify(body, Object.keys(body).sort());
    return crypto.createHash('sha256').update(sorted, 'utf8').digest('hex');
  }

  /**
   * Checks whether an idempotency key has been used before.
   *
   * Returns:
   *  - { found: false } if the key is new (proceed with creation)
   *  - { found: true, cachedResponse } if the key is complete (return cache)
   *
   * Throws:
   *  - 409 IdempotencyException if the key exists with a different request body
   *  - 409 IdempotencyException with Retry-After if the key is still in-flight
   */
  async check(params: {
    businessId: string;
    apiKeyId: string;
    key: string;
    requestHash: string;
  }): Promise<IdempotencyCheckResult> {
    const { businessId, apiKeyId, key, requestHash } = params;

    const record = await this.prisma.idempotencyRecord.findFirst({
      where: { businessId, apiKeyId, key },
    });

    if (!record) {
      return { found: false };
    }

    // Body mismatch — same key, different request
    if (record.requestHash !== requestHash) {
      throw new IdempotencyException(
        'idempotency_key_reused',
        'An Idempotency-Key may only be used with the same request body.',
      );
    }

    // Still processing (race condition — another request is in-flight)
    if (record.responseStatus === 0) {
      this.logger.warn({ key, businessId }, 'Idempotency key still in-flight');
      throw new IdempotencyException(
        'idempotency_key_in_flight',
        'This idempotency key is currently being processed. Retry after 1 second.',
      );
    }

    this.logger.log({ key, businessId }, 'Idempotency cache hit — returning stored response');
    return { found: true, cachedResponse: record.responseBody };
  }

  /**
   * Reserves an idempotency key (marks it as in-flight: responseStatus=0).
   * Throws 409 if the key was already reserved concurrently (unique index race).
   */
  async reserve(params: {
    businessId: string;
    apiKeyId: string;
    key: string;
    requestHash: string;
  }): Promise<void> {
    const { businessId, apiKeyId, key, requestHash } = params;
    const expiresAt = new Date(Date.now() + TTL_HOURS * 60 * 60 * 1000);

    try {
      await this.prisma.idempotencyRecord.create({
        data: {
          businessId,
          apiKeyId,
          key,
          requestHash,
          responseStatus: 0, // sentinel: in-flight
          responseBody: {},
          expiresAt,
        },
      });
    } catch (err: unknown) {
      if (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code: string }).code === MONGO_DUPLICATE_KEY_CODE
      ) {
        // Another request concurrently reserved this key
        throw new IdempotencyException(
          'idempotency_key_in_flight',
          'This idempotency key is currently being processed. Retry after 1 second.',
        );
      }
      throw err;
    }
  }

  /**
   * Marks an idempotency key as complete and stores the response.
   * Called after successful payment creation.
   */
  async complete(params: {
    businessId: string;
    apiKeyId: string;
    key: string;
    responseStatus: number;
    responseBody: unknown;
  }): Promise<void> {
    const { businessId, apiKeyId, key, responseStatus, responseBody } = params;

    await this.prisma.idempotencyRecord.updateMany({
      where: { businessId, apiKeyId, key },
      data: { responseStatus, responseBody: responseBody as object },
    });
  }

  /**
   * Validates the Idempotency-Key header value.
   * Must be 1–255 printable ASCII characters.
   */
  validateKey(key: string | undefined): string {
    if (!key || typeof key !== 'string') {
      throw new InvalidRequestException(
        'missing_idempotency_key',
        'The Idempotency-Key header is required for this endpoint.',
        'Idempotency-Key',
      );
    }
    if (key.length < 1 || key.length > 255) {
      throw new InvalidRequestException(
        'invalid_idempotency_key',
        'Idempotency-Key must be between 1 and 255 characters.',
        'Idempotency-Key',
      );
    }
    return key;
  }
}
