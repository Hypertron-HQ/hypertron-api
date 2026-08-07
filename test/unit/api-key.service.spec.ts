/**
 * Unit tests for ApiKeyService.
 *
 * The repository and ConfigService are fully mocked — no DB required.
 * Tests cover the full key lifecycle: generate, verify, revoke, rotate, list.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import type { ApiKey } from '@prisma/client';

import { ApiKeyService } from '@/modules/auth/api-key.service';
import { ApiKeyRepository } from '@/modules/auth/api-key.repository';
import { hashApiKey } from '@/common/utils/crypto.util';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Builds a minimal ApiKey fixture with defaults. Override fields as needed. */
function buildApiKey(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: 'mongo_id_1',
    publicId: 'key_01TESTID00000000000000000',
    businessId: 'biz_001',
    name: 'Test Key',
    environment: 'test',
    keyPrefix: 'sk_test_',
    secretHash: '$2b$04$placeholder',
    lastFour: 'abcd',
    active: true,
    lastUsedAt: null,
    createdAt: new Date('2024-01-01'),
    revokedAt: null,
    ...overrides,
  };
}

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockRepo: jest.Mocked<ApiKeyRepository> = {
  findActiveByPrefix: jest.fn(),
  findAllForBusiness: jest.fn(),
  findByPublicId: jest.fn(),
  create: jest.fn(),
  revoke: jest.fn(),
  rotate: jest.fn(),
  touchLastUsed: jest.fn(),
} as unknown as jest.Mocked<ApiKeyRepository>;

const mockConfig = {
  get: jest.fn().mockReturnValue({ apiKeySaltRounds: 4 }), // low rounds for speed
};

// ─── Setup ────────────────────────────────────────────────────────────────────

describe('ApiKeyService', () => {
  let service: ApiKeyService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApiKeyService,
        { provide: ApiKeyRepository, useValue: mockRepo },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

    service = module.get<ApiKeyService>(ApiKeyService);
  });

  // ─── generate() ───────────────────────────────────────────────────────────

  describe('generate()', () => {
    it('returns a raw key starting with sk_test_ for test environment', async () => {
      const fixture = buildApiKey();
      mockRepo.create.mockResolvedValue(fixture);

      const result = await service.generate({
        businessId: 'biz_001',
        name: 'Test Key',
        environment: 'test',
      });

      expect(result.rawKey).toMatch(/^sk_test_/);
    });

    it('returns a raw key starting with sk_live_ for live environment', async () => {
      const fixture = buildApiKey({ environment: 'live', keyPrefix: 'sk_live_' });
      mockRepo.create.mockResolvedValue(fixture);

      const result = await service.generate({
        businessId: 'biz_001',
        name: 'Live Key',
        environment: 'live',
      });

      expect(result.rawKey).toMatch(/^sk_live_/);
    });

    it('does NOT return secretHash in the record', async () => {
      const fixture = buildApiKey();
      mockRepo.create.mockResolvedValue(fixture);

      const result = await service.generate({
        businessId: 'biz_001',
        name: 'Test Key',
        environment: 'test',
      });

      expect(result.record).not.toHaveProperty('secretHash');
    });

    it('calls repository.create with the correct shape', async () => {
      const fixture = buildApiKey();
      mockRepo.create.mockResolvedValue(fixture);

      await service.generate({
        businessId: 'biz_001',
        name: 'My Key',
        environment: 'test',
      });

      const call = mockRepo.create.mock.calls[0][0];
      expect(call.businessId).toBe('biz_001');
      expect(call.name).toBe('My Key');
      expect(call.environment).toBe('test');
      expect(call.keyPrefix).toBe('sk_test_');
      expect(call.secretHash).toMatch(/^\$2[ab]\$/); // bcrypt format
      expect(call.lastFour).toHaveLength(4);
      expect(call.publicId).toMatch(/^key_/);
    });

    it('generates a unique publicId on each call', async () => {
      const fixture1 = buildApiKey({ publicId: 'key_UNIQUE1' });
      const fixture2 = buildApiKey({ publicId: 'key_UNIQUE2' });
      mockRepo.create
        .mockResolvedValueOnce(fixture1)
        .mockResolvedValueOnce(fixture2);

      const r1 = await service.generate({ businessId: 'biz_001', name: 'K1', environment: 'test' });
      const r2 = await service.generate({ businessId: 'biz_001', name: 'K2', environment: 'test' });

      expect(r1.record.publicId).not.toBe(r2.record.publicId);
    });
  });

  // ─── verify() ─────────────────────────────────────────────────────────────

  describe('verify()', () => {
    it('returns the record when a valid active key is provided', async () => {
      const rawKey = 'sk_test_validTokenHere1234567890123456789012';
      const hash = await hashApiKey(rawKey, 4);
      const fixture = buildApiKey({ keyPrefix: 'sk_test_', secretHash: hash });

      mockRepo.findActiveByPrefix.mockResolvedValue([fixture]);

      const result = await service.verify(rawKey);

      expect(result).not.toBeNull();
      expect(result!.record.publicId).toBe(fixture.publicId);
      expect(result!.record).not.toHaveProperty('secretHash');
    });

    it('returns null when the key does not match any candidate', async () => {
      const rawKey = 'sk_test_validTokenHere1234567890123456789012';
      const wrongHash = await hashApiKey('sk_test_completelyDifferent123456789012', 4);
      const fixture = buildApiKey({ keyPrefix: 'sk_test_', secretHash: wrongHash });

      mockRepo.findActiveByPrefix.mockResolvedValue([fixture]);

      const result = await service.verify(rawKey);

      expect(result).toBeNull();
    });

    it('returns null when no candidates exist for the prefix', async () => {
      mockRepo.findActiveByPrefix.mockResolvedValue([]);

      const result = await service.verify('sk_test_sometoken12345678901234567890ab');

      expect(result).toBeNull();
    });

    it('returns null for a malformed key (no underscore segments)', async () => {
      const result = await service.verify('notavalidkey');
      expect(result).toBeNull();
    });

    it('calls touchLastUsed on a successful match', async () => {
      const rawKey = 'sk_live_anotherValidToken12345678901234567890';
      const hash = await hashApiKey(rawKey, 4);
      const fixture = buildApiKey({
        environment: 'live',
        keyPrefix: 'sk_live_',
        secretHash: hash,
      });

      mockRepo.findActiveByPrefix.mockResolvedValue([fixture]);

      await service.verify(rawKey);

      expect(mockRepo.touchLastUsed).toHaveBeenCalledWith(fixture.id);
    });

    it('does NOT call touchLastUsed on a failed match', async () => {
      mockRepo.findActiveByPrefix.mockResolvedValue([]);

      await service.verify('sk_test_badtoken12345678901234567890abcde');

      expect(mockRepo.touchLastUsed).not.toHaveBeenCalled();
    });

    it('matches the first valid candidate among multiple', async () => {
      const rawKey = 'sk_test_correctToken12345678901234567890ab';
      const hash = await hashApiKey(rawKey, 4);
      const wrongHash = await hashApiKey('sk_test_wrongToken12345678901234567890ab', 4);

      const candidates = [
        buildApiKey({ id: 'id_1', publicId: 'key_WRONG', secretHash: wrongHash }),
        buildApiKey({ id: 'id_2', publicId: 'key_CORRECT', secretHash: hash }),
      ];

      mockRepo.findActiveByPrefix.mockResolvedValue(candidates);

      const result = await service.verify(rawKey);

      expect(result!.record.publicId).toBe('key_CORRECT');
    });
  });

  // ─── revoke() ─────────────────────────────────────────────────────────────

  describe('revoke()', () => {
    it('returns the revoked record (without secretHash) on success', async () => {
      const fixture = buildApiKey({ active: false, revokedAt: new Date() });
      mockRepo.revoke.mockResolvedValue(fixture);

      const result = await service.revoke('key_01TEST', 'biz_001');

      expect(result).not.toBeNull();
      expect(result).not.toHaveProperty('secretHash');
    });

    it('returns null when the key is not found', async () => {
      mockRepo.revoke.mockResolvedValue(null);

      const result = await service.revoke('key_NOTEXIST', 'biz_001');

      expect(result).toBeNull();
    });

    it('passes publicId and businessId to the repository', async () => {
      mockRepo.revoke.mockResolvedValue(buildApiKey({ active: false }));

      await service.revoke('key_01TESTID', 'biz_XYZ');

      expect(mockRepo.revoke).toHaveBeenCalledWith('key_01TESTID', 'biz_XYZ');
    });
  });

  // ─── rotate() ─────────────────────────────────────────────────────────────

  describe('rotate()', () => {
    it('returns a new rawKey and record on success', async () => {
      const oldKey = buildApiKey({ environment: 'test' });
      mockRepo.findByPublicId.mockResolvedValue(oldKey);

      const newKeyFixture = buildApiKey({ publicId: 'key_ROTATED' });
      mockRepo.rotate.mockResolvedValue(newKeyFixture);

      const result = await service.rotate('key_OLD', 'biz_001', 'Rotated Key');

      expect(result).not.toBeNull();
      expect(result!.rawKey).toMatch(/^sk_test_/);
      expect(result!.record.publicId).toBe('key_ROTATED');
      expect(result!.record).not.toHaveProperty('secretHash');
    });

    it('returns null when the old key is not found', async () => {
      mockRepo.findByPublicId.mockResolvedValue(null);

      const result = await service.rotate('key_NOTEXIST', 'biz_001', 'Key');

      expect(result).toBeNull();
    });

    it('returns null when the old key is already revoked (active=false)', async () => {
      mockRepo.findByPublicId.mockResolvedValue(buildApiKey({ active: false }));

      const result = await service.rotate('key_REVOKED', 'biz_001', 'Key');

      expect(result).toBeNull();
    });

    it('inherits environment from the old key', async () => {
      const oldKey = buildApiKey({ environment: 'live', keyPrefix: 'sk_live_' });
      mockRepo.findByPublicId.mockResolvedValue(oldKey);
      mockRepo.rotate.mockResolvedValue(buildApiKey({ environment: 'live' }));

      const result = await service.rotate('key_OLD', 'biz_001', 'Key');

      // The new raw key should be live
      expect(result!.rawKey).toMatch(/^sk_live_/);
    });

    it('returns null when rotate() repo call returns null (race condition)', async () => {
      mockRepo.findByPublicId.mockResolvedValue(buildApiKey());
      mockRepo.rotate.mockResolvedValue(null);

      const result = await service.rotate('key_OLD', 'biz_001', 'Key');

      expect(result).toBeNull();
    });
  });

  // ─── listForBusiness() ────────────────────────────────────────────────────

  describe('listForBusiness()', () => {
    it('returns keys without secretHash', async () => {
      const { secretHash: _s, ...safeKey } = buildApiKey();
      mockRepo.findAllForBusiness.mockResolvedValue([safeKey]);

      const result = await service.listForBusiness('biz_001');

      expect(result).toHaveLength(1);
      expect(result[0]).not.toHaveProperty('secretHash');
    });

    it('passes environment filter to the repository', async () => {
      mockRepo.findAllForBusiness.mockResolvedValue([]);

      await service.listForBusiness('biz_001', 'live');

      expect(mockRepo.findAllForBusiness).toHaveBeenCalledWith('biz_001', 'live');
    });

    it('returns an empty array when no keys exist', async () => {
      mockRepo.findAllForBusiness.mockResolvedValue([]);

      const result = await service.listForBusiness('biz_999');

      expect(result).toEqual([]);
    });
  });
});
