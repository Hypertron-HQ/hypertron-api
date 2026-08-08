/**
 * Unit tests for IdempotencyService.
 *
 * Covers:
 *  - hashBody produces stable, sorted SHA-256 hashes
 *  - check() returns { found: false } for new keys
 *  - check() returns cachedResponse for completed keys
 *  - check() throws 409 idempotency_key_reused on body mismatch
 *  - check() throws 409 idempotency_key_in_flight when in-flight
 *  - reserve() inserts in-flight record
 *  - reserve() throws 409 on duplicate key (concurrent race)
 *  - complete() stores the final response
 *  - validateKey() accepts valid keys, rejects missing/too-long
 */

import { Test, TestingModule } from '@nestjs/testing';
import { IdempotencyService } from '@/modules/idempotency/idempotency.service';
import { PrismaService } from '@/infrastructure/prisma/prisma.service';
import {
  IdempotencyException,
  InvalidRequestException,
} from '@/common/exceptions/hypertron.exception';

// ─── Mock Prisma ──────────────────────────────────────────────────────────────

function buildMockPrisma(record: object | null = null) {
  return {
    idempotencyRecord: {
      findFirst: jest.fn().mockResolvedValue(record),
      create: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
}

const BASE_PARAMS = {
  businessId: 'biz_001',
  apiKeyId: 'key_001',
  key: 'my-idempotency-key',
  requestHash: 'abc123',
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('IdempotencyService', () => {
  let service: IdempotencyService;
  let prisma: ReturnType<typeof buildMockPrisma>;

  async function build(record: object | null = null) {
    jest.clearAllMocks();
    prisma = buildMockPrisma(record);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IdempotencyService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get<IdempotencyService>(IdempotencyService);
  }

  // ─── hashBody ──────────────────────────────────────────────────────────────

  describe('hashBody()', () => {
    it('produces a 64-char hex string', async () => {
      await build();
      const hash = service.hashBody({ amount: '10', currency: 'USDC' });
      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[0-9a-f]+$/);
    });

    it('is deterministic', async () => {
      await build();
      const h1 = service.hashBody({ amount: '10', currency: 'USDC' });
      const h2 = service.hashBody({ amount: '10', currency: 'USDC' });
      expect(h1).toBe(h2);
    });

    it('is key-order independent (sorts keys before hashing)', async () => {
      await build();
      const h1 = service.hashBody({ amount: '10', currency: 'USDC' });
      const h2 = service.hashBody({ currency: 'USDC', amount: '10' });
      expect(h1).toBe(h2);
    });

    it('differs for different bodies', async () => {
      await build();
      const h1 = service.hashBody({ amount: '10' });
      const h2 = service.hashBody({ amount: '20' });
      expect(h1).not.toBe(h2);
    });
  });

  // ─── check() ──────────────────────────────────────────────────────────────

  describe('check()', () => {
    it('returns { found: false } when key does not exist', async () => {
      await build(null);
      const result = await service.check(BASE_PARAMS);
      expect(result.found).toBe(false);
    });

    it('returns { found: true, cachedResponse } when record is complete', async () => {
      const cached = { id: 'pay_1', status: 'pending' };
      await build({
        requestHash: BASE_PARAMS.requestHash,
        responseStatus: 201,
        responseBody: cached,
      });
      const result = await service.check(BASE_PARAMS);
      expect(result.found).toBe(true);
      expect(result.cachedResponse).toEqual(cached);
    });

    it('throws idempotency_key_reused on body mismatch', async () => {
      await build({
        requestHash: 'different_hash',
        responseStatus: 201,
        responseBody: {},
      });
      await expect(service.check(BASE_PARAMS)).rejects.toThrow(IdempotencyException);
      await expect(service.check(BASE_PARAMS)).rejects.toMatchObject({
        payload: { code: 'idempotency_key_reused' },
      });
    });

    it('throws idempotency_key_in_flight when responseStatus=0', async () => {
      await build({
        requestHash: BASE_PARAMS.requestHash,
        responseStatus: 0, // in-flight sentinel
        responseBody: {},
      });
      await expect(service.check(BASE_PARAMS)).rejects.toThrow(IdempotencyException);
      await expect(service.check(BASE_PARAMS)).rejects.toMatchObject({
        payload: { code: 'idempotency_key_in_flight' },
      });
    });
  });

  // ─── reserve() ────────────────────────────────────────────────────────────

  describe('reserve()', () => {
    it('calls prisma.create with in-flight sentinel (responseStatus=0)', async () => {
      await build(null);
      await service.reserve(BASE_PARAMS);
      expect(prisma.idempotencyRecord.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ responseStatus: 0 }),
        }),
      );
    });

    it('throws idempotency_key_in_flight on P2002 duplicate key error', async () => {
      await build(null);
      prisma.idempotencyRecord.create.mockRejectedValue({ code: 'P2002' });
      await expect(service.reserve(BASE_PARAMS)).rejects.toThrow(IdempotencyException);
      await expect(service.reserve(BASE_PARAMS)).rejects.toMatchObject({
        payload: { code: 'idempotency_key_in_flight' },
      });
    });

    it('re-throws non-duplicate errors', async () => {
      await build(null);
      prisma.idempotencyRecord.create.mockRejectedValue(new Error('DB connection failed'));
      await expect(service.reserve(BASE_PARAMS)).rejects.toThrow('DB connection failed');
    });
  });

  // ─── complete() ───────────────────────────────────────────────────────────

  describe('complete()', () => {
    it('calls updateMany with responseStatus and responseBody', async () => {
      await build(null);
      const body = { id: 'pay_1' };
      await service.complete({ ...BASE_PARAMS, responseStatus: 201, responseBody: body });
      expect(prisma.idempotencyRecord.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ responseStatus: 201, responseBody: body }),
        }),
      );
    });
  });

  // ─── validateKey() ────────────────────────────────────────────────────────

  describe('validateKey()', () => {
    it('returns the key when valid', async () => {
      await build(null);
      expect(service.validateKey('my-key-123')).toBe('my-key-123');
    });

    it('throws InvalidRequestException for undefined', async () => {
      await build(null);
      expect(() => service.validateKey(undefined)).toThrow(InvalidRequestException);
      expect(() => service.validateKey(undefined)).toThrow(
        expect.objectContaining({ payload: { code: 'missing_idempotency_key', type: 'invalid_request_error', message: expect.any(String), param: 'Idempotency-Key' } }),
      );
    });

    it('throws InvalidRequestException for empty string', async () => {
      await build(null);
      expect(() => service.validateKey('')).toThrow(InvalidRequestException);
    });

    it('throws InvalidRequestException for key longer than 255 chars', async () => {
      await build(null);
      expect(() => service.validateKey('a'.repeat(256))).toThrow(InvalidRequestException);
    });

    it('accepts key of exactly 255 chars', async () => {
      await build(null);
      expect(() => service.validateKey('a'.repeat(255))).not.toThrow();
    });

    it('accepts key of exactly 1 char', async () => {
      await build(null);
      expect(() => service.validateKey('x')).not.toThrow();
    });
  });
});
