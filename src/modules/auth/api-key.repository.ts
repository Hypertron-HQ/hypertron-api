/**
 * ApiKeyRepository — data access for ApiKey documents.
 *
 * Responsibilities:
 *  - Fetch candidate keys by prefix for guard lookup
 *  - Create, revoke, and update keys
 *  - Fire-and-forget lastUsedAt update (non-blocking)
 *
 * Never throws HTTP exceptions — callers handle domain logic.
 */

import { Injectable } from '@nestjs/common';
import type { ApiKey } from '@prisma/client';
import { PrismaService } from '@/infrastructure/prisma/prisma.service';

export interface CreateApiKeyInput {
  publicId: string;
  businessId: string;
  name: string;
  environment: 'test' | 'live';
  keyPrefix: string;
  secretHash: string;
  lastFour: string;
}

@Injectable()
export class ApiKeyRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Finds all active keys for a given keyPrefix.
   *
   * The guard calls this first (fast index scan) then does bcrypt comparison
   * in the service layer. There should be very few records per prefix.
   */
  async findActiveByPrefix(keyPrefix: string): Promise<ApiKey[]> {
    return this.prisma.apiKey.findMany({
      where: { keyPrefix, active: true },
    });
  }

  /**
   * Finds all active keys for a specific business + environment (dashboard listing).
   * Never returns secretHash.
   */
  async findAllForBusiness(
    businessId: string,
    environment?: 'test' | 'live',
  ): Promise<Omit<ApiKey, 'secretHash'>[]> {
    return this.findAllForBusinessIds([businessId], environment);
  }

  /**
   * Finds all active keys for one or more businesses.
   * Never returns secretHash.
   */
  async findAllForBusinessIds(
    businessIds: string[],
    environment?: 'test' | 'live',
  ): Promise<Omit<ApiKey, 'secretHash'>[]> {
    if (businessIds.length === 0) return [];

    const where: {
      businessId: { in: string[] };
      active: boolean;
      environment: 'test' | 'live' | { in: Array<'test' | 'live'> };
    } = {
      businessId: { in: businessIds },
      active: true,
      // Dashboard listing intentionally spans both environments. Making that
      // scope explicit satisfies the Prisma isolation guard.
      environment: environment ?? { in: ['test', 'live'] },
    };

    const keys = await this.prisma.apiKey.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });

    return keys.map(({ secretHash: _hash, ...rest }) => rest);
  }

  /** Finds a single key by its publicId, scoped to a businessId. */
  async findByPublicId(
    publicId: string,
    businessId: string,
  ): Promise<ApiKey | null> {
    return this.prisma.apiKey.findFirst({
      where: { publicId, businessId },
    });
  }

  /** Creates a new API key record. */
  async create(input: CreateApiKeyInput): Promise<ApiKey> {
    return this.prisma.apiKey.create({
      data: {
        publicId: input.publicId,
        businessId: input.businessId,
        name: input.name,
        environment: input.environment,
        keyPrefix: input.keyPrefix,
        secretHash: input.secretHash,
        lastFour: input.lastFour,
        active: true,
      },
    });
  }

  /**
   * Marks a key as revoked (active = false).
   * Returns null if the key does not belong to businessId (cross-merchant safety).
   */
  async revoke(publicId: string, businessId: string): Promise<ApiKey | null> {
    const key = await this.prisma.apiKey.findFirst({
      where: { publicId, businessId, active: true },
    });
    if (!key) return null;

    return this.prisma.apiKey.update({
      where: { id: key.id },
      data: { active: false, revokedAt: new Date() },
    });
  }

  /**
   * Rotates a key: revokes the old one and creates the replacement in a
   * transaction. Returns the new key record.
   */
  async rotate(
    oldPublicId: string,
    businessId: string,
    newKeyInput: CreateApiKeyInput,
  ): Promise<ApiKey | null> {
    const old = await this.prisma.apiKey.findFirst({
      where: { publicId: oldPublicId, businessId, active: true },
    });
    if (!old) return null;

    const [, newKey] = await this.prisma.$transaction([
      this.prisma.apiKey.update({
        where: { id: old.id },
        data: { active: false, revokedAt: new Date() },
      }),
      this.prisma.apiKey.create({
        data: {
          publicId: newKeyInput.publicId,
          businessId: newKeyInput.businessId,
          name: newKeyInput.name,
          environment: newKeyInput.environment,
          keyPrefix: newKeyInput.keyPrefix,
          secretHash: newKeyInput.secretHash,
          lastFour: newKeyInput.lastFour,
          active: true,
        },
      }),
    ]);

    return newKey;
  }

  /**
   * Updates lastUsedAt asynchronously — fire-and-forget.
   * Intentionally does NOT await; errors are swallowed to avoid request latency.
   */
  touchLastUsed(id: string): void {
    void this.prisma.apiKey
      .update({ where: { id }, data: { lastUsedAt: new Date() } })
      .catch(() => {
        // Non-critical; do not impact the request
      });
  }
}
