/**
 * ApiKeyService — business logic for API key lifecycle.
 *
 * Responsibilities:
 *  - generate(): produce a new raw key + create the DB record
 *  - verify(): bcrypt-compare an incoming raw key against stored candidates
 *  - revoke() / rotate(): key lifecycle management
 *
 * SECURITY rules enforced here:
 *  - Raw key is returned ONCE from generate() and never stored
 *  - secretHash is never returned from any method
 *  - Only keyPrefix + lastFour are safe to include in responses
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ApiKey } from '@prisma/client';

import {
  generateApiKey,
  getKeyPrefix,
  getKeyLastFour,
  hashApiKey,
  verifyApiKey,
} from '@/common/utils/crypto.util';
import { generateId, PREFIXES } from '@/common/utils/id-generator';
import type { SecurityConfig } from '@/common/config/security.config';
import { ApiKeyRepository } from './api-key.repository';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface GenerateKeyResult {
  /** The raw key — shown once, never stored again */
  rawKey: string;
  /** The created ApiKey record (secretHash stripped) */
  record: Omit<ApiKey, 'secretHash'>;
}

export interface VerifyKeyResult {
  /** The matched ApiKey record (secretHash stripped) */
  record: Omit<ApiKey, 'secretHash'>;
}

// ─── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class ApiKeyService {
  private readonly logger = new Logger(ApiKeyService.name);

  constructor(
    private readonly repository: ApiKeyRepository,
    private readonly config: ConfigService,
  ) {}

  /**
   * Generates a new API key for a business.
   *
   * Flow:
   *  1. Generate raw key (`sk_test_...` or `sk_live_...`)
   *  2. Hash with bcrypt (saltRounds from config)
   *  3. Persist to DB (hash only — not raw)
   *  4. Return raw key + DB record to caller
   *
   * The raw key must be shown to the user exactly once.
   */
  async generate(params: {
    businessId: string;
    name: string;
    environment: 'test' | 'live';
  }): Promise<GenerateKeyResult> {
    const { businessId, name, environment } = params;

    const rawKey = generateApiKey(environment);
    const keyPrefix = getKeyPrefix(rawKey);
    const lastFour = getKeyLastFour(rawKey);

    const saltRounds =
      this.config.get<SecurityConfig>('security')!.apiKeySaltRounds;
    const secretHash = await hashApiKey(rawKey, saltRounds);

    const publicId = generateId(PREFIXES.API_KEY);

    const created = await this.repository.create({
      publicId,
      businessId,
      name,
      environment,
      keyPrefix,
      secretHash,
      lastFour,
    });

    // Strip secretHash before returning
    const { secretHash: _stripped, ...record } = created;

    this.logger.log(
      { businessId, keyPrefix, environment },
      'API key generated',
    );

    return { rawKey, record };
  }

  /**
   * Verifies an incoming raw key against active DB records.
   *
   * Lookup flow (as per spec section 9.1):
   *  1. Extract prefix from the raw key → index scan (fast)
   *  2. Load all active candidate records for that prefix
   *  3. bcrypt.compare against each candidate's secretHash
   *  4. Confirm active=true on the matched record
   *
   * Returns null if no valid match found (caller returns 401).
   * Fires lastUsedAt update asynchronously (non-blocking).
   */
  async verify(rawKey: string): Promise<VerifyKeyResult | null> {
    let keyPrefix: string;
    try {
      keyPrefix = getKeyPrefix(rawKey);
    } catch {
      // Malformed key format — not a valid key
      return null;
    }

    const candidates = await this.repository.findActiveByPrefix(keyPrefix);

    if (candidates.length === 0) {
      this.logger.warn(
        { keyPrefix },
        'No active key candidates found for prefix',
      );
      return null;
    }

    for (const candidate of candidates) {
      const matches = await verifyApiKey(rawKey, candidate.secretHash);
      if (matches) {
        // Fire-and-forget lastUsedAt update
        this.repository.touchLastUsed(candidate.id);

        this.logger.log(
          { keyPrefix, apiKeyId: candidate.publicId },
          'API key verified',
        );

        const { secretHash: _stripped, ...record } = candidate;
        return { record };
      }
    }

    this.logger.warn(
      { keyPrefix },
      'API key verification failed — no bcrypt match',
    );
    return null;
  }

  /**
   * Revokes an API key by publicId, scoped to a businessId.
   * Returns the revoked record, or null if not found / already revoked.
   */
  async revoke(
    publicId: string,
    businessId: string,
  ): Promise<Omit<ApiKey, 'secretHash'> | null> {
    const revoked = await this.repository.revoke(publicId, businessId);
    if (!revoked) return null;

    const { secretHash: _stripped, ...record } = revoked;
    this.logger.log({ publicId, businessId }, 'API key revoked');
    return record;
  }

  /**
   * Rotates an API key: atomically revokes old + creates new.
   * Returns { rawKey, record } for the new key, or null if the old key was not found.
   */
  async rotate(
    oldPublicId: string,
    businessId: string,
    name: string,
  ): Promise<GenerateKeyResult | null> {
    // Fetch old key to inherit environment
    const old = await this.repository.findByPublicId(oldPublicId, businessId);
    if (!old || !old.active) return null;

    const environment = old.environment;
    const rawKey = generateApiKey(environment);
    const keyPrefix = getKeyPrefix(rawKey);
    const lastFour = getKeyLastFour(rawKey);

    const saltRounds =
      this.config.get<SecurityConfig>('security')!.apiKeySaltRounds;
    const secretHash = await hashApiKey(rawKey, saltRounds);
    const publicId = generateId(PREFIXES.API_KEY);

    const newKey = await this.repository.rotate(oldPublicId, businessId, {
      publicId,
      businessId,
      name,
      environment,
      keyPrefix,
      secretHash,
      lastFour,
    });

    if (!newKey) return null;

    const { secretHash: _stripped, ...record } = newKey;
    this.logger.log(
      { oldPublicId, newPublicId: publicId, businessId },
      'API key rotated',
    );
    return { rawKey, record };
  }

  /**
   * Lists all active API keys for a business (secretHash never returned).
   */
  async listForBusiness(
    businessId: string,
    environment?: 'test' | 'live',
  ): Promise<Omit<ApiKey, 'secretHash'>[]> {
    return this.repository.findAllForBusiness(businessId, environment);
  }
}
