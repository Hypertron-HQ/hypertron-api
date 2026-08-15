/**
 * Cryptographic utilities for the HyperTone Payments API.
 *
 * Covers:
 *  - API key generation and bcrypt hashing
 *  - Webhook payload HMAC-SHA256 signing
 *  - Signing secret AES-256-GCM encryption / decryption
 *  - Request ID generation
 *
 * SECURITY: Raw keys, signing secrets, and encryption keys must NEVER be
 * logged or returned in API responses. Functions in this module handle only
 * the cryptographic operations — callers are responsible for secret hygiene.
 */

import * as crypto from 'crypto';
import * as bcrypt from 'bcrypt';
import { generateId, PREFIXES } from './id-generator';

// ─── Constants ────────────────────────────────────────────────────────────────

/** bcrypt salt rounds used when not explicitly supplied (e.g. in tests). */
const DEFAULT_SALT_ROUNDS = 12;

/** AES-256-GCM parameters */
const AES_ALGO = 'aes-256-gcm' as const;
const AES_IV_BYTES = 12; // 96-bit IV recommended for GCM
const AES_TAG_BYTES = 16; // 128-bit auth tag

/** Separator used in the encrypted secret envelope: `<iv_hex>:<tag_hex>:<ciphertext_hex>` */
const ENVELOPE_SEP = ':';

// ─── API Key utilities ────────────────────────────────────────────────────────

/**
 * Generates a new raw API key with the appropriate environment prefix.
 *
 * Format: `sk_test_<44-char base64url token>` or `sk_live_<44-char base64url token>`
 * The raw key is returned once and must never be stored.
 */
export function generateApiKey(environment: 'test' | 'live'): string {
  const token = crypto.randomBytes(32).toString('base64url');
  return `sk_${environment}_${token}`;
}

/**
 * Returns the last four characters of a raw API key (for display purposes).
 */
export function getKeyLastFour(rawKey: string): string {
  return rawKey.slice(-4);
}

/**
 * Returns the key prefix segment (e.g. `sk_test_`) from a raw key.
 * Prefix is everything up to and including the second underscore.
 */
export function getKeyPrefix(rawKey: string): string {
  const parts = rawKey.split('_');
  if (parts.length < 3) {
    throw new Error('Invalid API key format — expected sk_<env>_<token>');
  }
  // "sk", "test", <token> → prefix is "sk_test_"
  return `${parts[0]}_${parts[1]}_`;
}

/**
 * Hashes a raw API key with bcrypt.
 * Uses the supplied salt rounds (from config) or falls back to the default.
 */
export async function hashApiKey(
  rawKey: string,
  saltRounds: number = DEFAULT_SALT_ROUNDS,
): Promise<string> {
  return bcrypt.hash(rawKey, saltRounds);
}

/**
 * Verifies a raw API key against its stored bcrypt hash.
 */
export async function verifyApiKey(
  rawKey: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(rawKey, hash);
}

// ─── Signing secret utilities ──────────────────────────────────────────────────

/**
 * Generates a new webhook signing secret as a 64-char hex string (32 bytes).
 */
export function generateSigningSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Encrypts a plaintext signing secret using AES-256-GCM.
 *
 * The encryption key must be a 32-byte Buffer (256 bits).
 *
 * Returns an opaque envelope string: `<iv_hex>:<tag_hex>:<ciphertext_hex>`
 * that can be stored at rest.
 */
export function encryptSecret(plaintext: string, key: Buffer): string {
  if (key.length !== 32) {
    throw new Error('Encryption key must be exactly 32 bytes (256 bits)');
  }
  const iv = crypto.randomBytes(AES_IV_BYTES);
  const cipher = crypto.createCipheriv(AES_ALGO, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    iv.toString('hex'),
    tag.toString('hex'),
    ciphertext.toString('hex'),
  ].join(ENVELOPE_SEP);
}

/**
 * Decrypts an encrypted signing secret envelope produced by `encryptSecret`.
 *
 * Throws if the envelope is malformed, the key is wrong, or the auth tag fails.
 */
export function decryptSecret(envelope: string, key: Buffer): string {
  if (key.length !== 32) {
    throw new Error('Encryption key must be exactly 32 bytes (256 bits)');
  }
  const parts = envelope.split(ENVELOPE_SEP);
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted secret envelope format');
  }
  const [ivHex, tagHex, ciphertextHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');

  if (iv.length !== AES_IV_BYTES) {
    throw new Error('Invalid IV length in encrypted secret envelope');
  }
  if (tag.length !== AES_TAG_BYTES) {
    throw new Error('Invalid auth tag length in encrypted secret envelope');
  }

  const decipher = crypto.createDecipheriv(AES_ALGO, key, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString('utf8');
}

// ─── Webhook HMAC signing ──────────────────────────────────────────────────────

/**
 * Signs a webhook payload using HMAC-SHA256.
 *
 * @param signingSecret  Hex-encoded signing secret (output of `generateSigningSecret`)
 * @param timestamp      Unix seconds timestamp
 * @param body           JSON-serialised request body string
 *
 * Returns the full `Hypertron-Signature` header value:
 * `t=<timestamp>,v1=<hex_hmac>`
 */
export function signWebhookPayload(
  signingSecret: string,
  timestamp: number,
  body: string,
): string {
  const signedInput = `${timestamp}.${body}`;
  const hmac = crypto
    .createHmac('sha256', Buffer.from(signingSecret, 'hex'))
    .update(signedInput, 'utf8')
    .digest('hex');
  return `t=${timestamp},v1=${hmac}`;
}

/**
 * Verifies a `Hypertron-Signature` header value against the expected payload.
 *
 * @param header         Full header value: `t=<ts>,v1=<sig>`
 * @param signingSecret  Hex-encoded signing secret
 * @param body           JSON-serialised request body string
 * @param toleranceMs    Max allowed clock skew in milliseconds (default: 5 minutes)
 */
export function verifyWebhookSignature(
  header: string,
  signingSecret: string,
  body: string,
  toleranceMs: number = 5 * 60 * 1000,
): boolean {
  const parts = Object.fromEntries(
    header.split(',').map((p) => p.split('=') as [string, string]),
  );
  const timestamp = parseInt(parts['t'] ?? '', 10);
  const signature = parts['v1'];

  if (!timestamp || !signature) return false;

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) * 1000 > toleranceMs) return false;

  const expected = signWebhookPayload(signingSecret, timestamp, body);
  const expectedSig = expected.split(',v1=')[1] ?? '';

  // Constant-time comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expectedSig, 'hex'),
    );
  } catch {
    return false;
  }
}

// ─── Request ID ────────────────────────────────────────────────────────────────

/**
 * Generates a unique request ID with the `req_` prefix.
 */
export function generateRequestId(): string {
  return generateId(PREFIXES.REQUEST);
}
