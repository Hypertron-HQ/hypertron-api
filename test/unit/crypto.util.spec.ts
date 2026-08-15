import * as crypto from 'crypto';
import {
  generateApiKey,
  getKeyLastFour,
  getKeyPrefix,
  hashApiKey,
  verifyApiKey,
  generateSigningSecret,
  encryptSecret,
  decryptSecret,
  signWebhookPayload,
  verifyWebhookSignature,
  generateRequestId,
} from '@/common/utils/crypto.util';

// ─── generateApiKey ───────────────────────────────────────────────────────────

describe('generateApiKey()', () => {
  it('generates a test key with sk_test_ prefix', () => {
    const key = generateApiKey('test');
    expect(key).toMatch(/^sk_test_.+/);
  });

  it('generates a live key with sk_live_ prefix', () => {
    const key = generateApiKey('live');
    expect(key).toMatch(/^sk_live_.+/);
  });

  it('generates unique keys on successive calls', () => {
    const keys = new Set(
      Array.from({ length: 50 }, () => generateApiKey('test')),
    );
    expect(keys.size).toBe(50);
  });

  it('the token portion is base64url-safe (no + or /)', () => {
    for (let i = 0; i < 20; i++) {
      const key = generateApiKey('test');
      const token = key.replace('sk_test_', '');
      expect(token).not.toMatch(/[+/=]/);
    }
  });
});

// ─── getKeyLastFour ───────────────────────────────────────────────────────────

describe('getKeyLastFour()', () => {
  it('returns exactly the last 4 characters', () => {
    expect(getKeyLastFour('sk_test_abcdefghij')).toBe('ghij');
  });

  it('works for live keys', () => {
    const key = 'sk_live_XYZ1234';
    expect(getKeyLastFour(key)).toBe('1234');
  });
});

// ─── getKeyPrefix ─────────────────────────────────────────────────────────────

describe('getKeyPrefix()', () => {
  it('returns sk_test_ for a test key', () => {
    expect(getKeyPrefix('sk_test_sometoken')).toBe('sk_test_');
  });

  it('returns sk_live_ for a live key', () => {
    expect(getKeyPrefix('sk_live_sometoken')).toBe('sk_live_');
  });

  it('throws for a malformed key with fewer than 3 underscore-separated parts', () => {
    expect(() => getKeyPrefix('sk_test')).toThrow('Invalid API key format');
  });

  it('throws for a key with no underscore', () => {
    expect(() => getKeyPrefix('badkey')).toThrow('Invalid API key format');
  });
});

// ─── hashApiKey / verifyApiKey ────────────────────────────────────────────────

describe('hashApiKey() and verifyApiKey()', () => {
  const rawKey = generateApiKey('test');

  it('produces a bcrypt hash string', async () => {
    const hash = await hashApiKey(rawKey, 4); // low rounds for speed in tests
    expect(hash).toMatch(/^\$2[ab]\$\d+\$/);
  });

  it('uses the default salt rounds when none are provided', async () => {
    // Just ensure it resolves without error and returns a bcrypt hash
    const hash = await hashApiKey(rawKey);
    expect(hash).toMatch(/^\$2[ab]\$12\$/); // 12 rounds is the default
  }, 30_000);

  it('verifyApiKey returns true for matching key and hash', async () => {
    const hash = await hashApiKey(rawKey, 4);
    const result = await verifyApiKey(rawKey, hash);
    expect(result).toBe(true);
  });

  it('verifyApiKey returns false for a wrong key', async () => {
    const hash = await hashApiKey(rawKey, 4);
    const result = await verifyApiKey('sk_test_wrongkey', hash);
    expect(result).toBe(false);
  });

  it('two hashes of the same key are different (salt randomness)', async () => {
    const hash1 = await hashApiKey(rawKey, 4);
    const hash2 = await hashApiKey(rawKey, 4);
    expect(hash1).not.toBe(hash2);
    // Both should still verify
    await expect(verifyApiKey(rawKey, hash1)).resolves.toBe(true);
    await expect(verifyApiKey(rawKey, hash2)).resolves.toBe(true);
  });
});

// ─── generateSigningSecret ────────────────────────────────────────────────────

describe('generateSigningSecret()', () => {
  it('returns a 64-character hex string (32 bytes)', () => {
    const secret = generateSigningSecret();
    expect(secret).toHaveLength(64);
    expect(secret).toMatch(/^[0-9a-f]+$/);
  });

  it('generates unique secrets', () => {
    const secrets = new Set(
      Array.from({ length: 50 }, () => generateSigningSecret()),
    );
    expect(secrets.size).toBe(50);
  });
});

// ─── encryptSecret / decryptSecret ───────────────────────────────────────────

describe('encryptSecret() and decryptSecret()', () => {
  const key = crypto.randomBytes(32);
  const plaintext = generateSigningSecret();

  it('encrypts and decrypts successfully', () => {
    const envelope = encryptSecret(plaintext, key);
    const decrypted = decryptSecret(envelope, key);
    expect(decrypted).toBe(plaintext);
  });

  it('produces different ciphertexts each call (random IV)', () => {
    const e1 = encryptSecret(plaintext, key);
    const e2 = encryptSecret(plaintext, key);
    expect(e1).not.toBe(e2);
    // Both decrypt correctly
    expect(decryptSecret(e1, key)).toBe(plaintext);
    expect(decryptSecret(e2, key)).toBe(plaintext);
  });

  it('the envelope has 3 colon-separated parts', () => {
    const envelope = encryptSecret(plaintext, key);
    expect(envelope.split(':').length).toBe(3);
  });

  it('throws when encryption key is not 32 bytes', () => {
    const badKey = crypto.randomBytes(16);
    expect(() => encryptSecret(plaintext, badKey)).toThrow(
      'Encryption key must be exactly 32 bytes',
    );
  });

  it('throws when decryption key is not 32 bytes', () => {
    const envelope = encryptSecret(plaintext, key);
    const badKey = crypto.randomBytes(16);
    expect(() => decryptSecret(envelope, badKey)).toThrow(
      'Encryption key must be exactly 32 bytes',
    );
  });

  it('throws when decrypting with the wrong key', () => {
    const envelope = encryptSecret(plaintext, key);
    const wrongKey = crypto.randomBytes(32);
    expect(() => decryptSecret(envelope, wrongKey)).toThrow();
  });

  it('throws for a malformed envelope (wrong number of parts)', () => {
    expect(() => decryptSecret('onlyone', key)).toThrow(
      'Invalid encrypted secret envelope format',
    );
    expect(() => decryptSecret('a:b', key)).toThrow(
      'Invalid encrypted secret envelope format',
    );
  });

  it('throws for an envelope with invalid IV length', () => {
    const envelope = encryptSecret(plaintext, key);
    const parts = envelope.split(':');
    // Truncate the IV
    const tampered = `${parts[0].slice(0, 10)}:${parts[1]}:${parts[2]}`;
    expect(() => decryptSecret(tampered, key)).toThrow();
  });

  it('throws for an envelope with invalid auth tag length', () => {
    const envelope = encryptSecret(plaintext, key);
    const parts = envelope.split(':');
    const tampered = `${parts[0]}:${parts[1].slice(0, 10)}:${parts[2]}`;
    expect(() => decryptSecret(tampered, key)).toThrow();
  });
});

// ─── signWebhookPayload ───────────────────────────────────────────────────────

describe('signWebhookPayload()', () => {
  const secret = generateSigningSecret();
  const timestamp = 1_700_000_000;
  const body = JSON.stringify({ id: 'evt_test', type: 'payment.completed' });

  it('returns a signature header string with t= and v1= parts', () => {
    const header = signWebhookPayload(secret, timestamp, body);
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]+$/);
  });

  it('includes the correct timestamp', () => {
    const header = signWebhookPayload(secret, timestamp, body);
    expect(header.startsWith(`t=${timestamp},`)).toBe(true);
  });

  it('is deterministic for the same inputs', () => {
    const h1 = signWebhookPayload(secret, timestamp, body);
    const h2 = signWebhookPayload(secret, timestamp, body);
    expect(h1).toBe(h2);
  });

  it('produces different signatures for different secrets', () => {
    const otherSecret = generateSigningSecret();
    const h1 = signWebhookPayload(secret, timestamp, body);
    const h2 = signWebhookPayload(otherSecret, timestamp, body);
    expect(h1).not.toBe(h2);
  });

  it('produces different signatures for different timestamps', () => {
    const h1 = signWebhookPayload(secret, timestamp, body);
    const h2 = signWebhookPayload(secret, timestamp + 1, body);
    expect(h1).not.toBe(h2);
  });

  it('produces different signatures for different bodies', () => {
    const h1 = signWebhookPayload(secret, timestamp, body);
    const h2 = signWebhookPayload(secret, timestamp, body + 'x');
    expect(h1).not.toBe(h2);
  });

  it('matches a known HMAC-SHA256 vector', () => {
    // Pre-computed expected value
    const knownSecret = 'a'.repeat(64); // 32-byte hex key
    const knownTimestamp = 1_000_000_000;
    const knownBody = '{"id":"test"}';
    const signedInput = `${knownTimestamp}.${knownBody}`;
    const expected = crypto
      .createHmac('sha256', Buffer.from(knownSecret, 'hex'))
      .update(signedInput, 'utf8')
      .digest('hex');
    const header = signWebhookPayload(knownSecret, knownTimestamp, knownBody);
    expect(header).toBe(`t=${knownTimestamp},v1=${expected}`);
  });
});

// ─── verifyWebhookSignature ───────────────────────────────────────────────────

describe('verifyWebhookSignature()', () => {
  const secret = generateSigningSecret();
  const body = JSON.stringify({ id: 'evt_test' });

  it('returns true for a valid, fresh signature', () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const header = signWebhookPayload(secret, timestamp, body);
    expect(verifyWebhookSignature(header, secret, body)).toBe(true);
  });

  it('returns false for a tampered body', () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const header = signWebhookPayload(secret, timestamp, body);
    expect(verifyWebhookSignature(header, secret, body + 'tampered')).toBe(
      false,
    );
  });

  it('returns false for the wrong secret', () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const header = signWebhookPayload(secret, timestamp, body);
    expect(verifyWebhookSignature(header, generateSigningSecret(), body)).toBe(
      false,
    );
  });

  it('returns false for a timestamp outside the tolerance window', () => {
    const oldTimestamp = Math.floor(Date.now() / 1000) - 600; // 10 minutes ago
    const header = signWebhookPayload(secret, oldTimestamp, body);
    expect(verifyWebhookSignature(header, secret, body, 5 * 60 * 1000)).toBe(
      false,
    );
  });

  it('returns true for a timestamp within the tolerance window', () => {
    const recentTimestamp = Math.floor(Date.now() / 1000) - 60; // 1 minute ago
    const header = signWebhookPayload(secret, recentTimestamp, body);
    expect(verifyWebhookSignature(header, secret, body)).toBe(true);
  });

  it('returns false for a malformed header (missing t=)', () => {
    expect(verifyWebhookSignature('v1=abc123', secret, body)).toBe(false);
  });

  it('returns false for a malformed header (missing v1=)', () => {
    const ts = Math.floor(Date.now() / 1000);
    expect(verifyWebhookSignature(`t=${ts}`, secret, body)).toBe(false);
  });

  it('returns false when v1= is present but the split produces no signature part', () => {
    // Header has t= and v1= but in a way that the v1 value comes out empty
    const ts = Math.floor(Date.now() / 1000);
    // Craft a header where split on ',v1=' yields an empty second element
    expect(verifyWebhookSignature(`t=${ts},v1=`, secret, body)).toBe(false);
  });

  it('returns false for an empty header', () => {
    expect(verifyWebhookSignature('', secret, body)).toBe(false);
  });

  it('returns false when signature has wrong length (cannot timingSafeEqual)', () => {
    const ts = Math.floor(Date.now() / 1000);
    const header = `t=${ts},v1=abcd`; // too short
    expect(verifyWebhookSignature(header, secret, body)).toBe(false);
  });
});

// ─── generateRequestId ────────────────────────────────────────────────────────

describe('generateRequestId()', () => {
  it('generates a string with req_ prefix', () => {
    const id = generateRequestId();
    expect(id).toMatch(/^req_[0-9A-Z]{26}$/);
  });

  it('generates unique request ids', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateRequestId()));
    expect(ids.size).toBe(50);
  });
});
