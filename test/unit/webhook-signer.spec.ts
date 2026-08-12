/**
 * Unit tests — WebhookSigner + retry policy helpers (Plan §13.3–13.5)
 *
 * Covers:
 *  - Signature header format and known vector
 *  - Merchant-side verification round trip (tamper, wrong secret, stale timestamp)
 *  - AES-256-GCM secret envelope round trip and key validation
 *  - Retry schedule and retryable-status classification
 */

import * as crypto from 'crypto';
import { ConfigService } from '@nestjs/config';

import { WebhookSigner } from '@/modules/webhooks/webhook-signer';
import { verifyWebhookSignature } from '@/common/utils/crypto.util';
import { ApiException } from '@/common/exceptions/hypertron.exception';
import {
  isRetryableStatus,
  retryDelayMs,
  MAX_DELIVERY_ATTEMPTS,
  RETRY_DELAYS_MS,
} from '@/modules/webhooks/webhooks.constants';

const ENCRYPTION_KEY = 'a'.repeat(64);

function signerWith(key: string): WebhookSigner {
  const config = {
    get: () => ({ webhookSecretEncryptionKey: key }),
  } as unknown as ConfigService;
  return new WebhookSigner(config);
}

describe('WebhookSigner', () => {
  let signer: WebhookSigner;

  beforeEach(() => {
    signer = signerWith(ENCRYPTION_KEY);
  });

  describe('generateSecret', () => {
    it('returns a 64-char hex secret', () => {
      const secret = signer.generateSecret();
      expect(secret).toMatch(/^[0-9a-f]{64}$/);
    });

    it('returns a different secret each call', () => {
      expect(signer.generateSecret()).not.toBe(signer.generateSecret());
    });

    it('lastFour returns the final four characters', () => {
      const secret = signer.generateSecret();
      expect(signer.lastFour(secret)).toBe(secret.slice(-4));
    });
  });

  describe('sign', () => {
    it('produces the t=<ts>,v1=<hex> header format', () => {
      const header = signer.sign(
        signer.generateSecret(),
        '{"a":1}',
        1785750670,
      );
      expect(header).toMatch(/^t=1785750670,v1=[0-9a-f]{64}$/);
    });

    it('matches an independently computed HMAC over `${t}.${body}`', () => {
      const secret = 'b'.repeat(64);
      const body = '{"id":"evt_1"}';
      const timestamp = 1785750670;

      const expected = crypto
        .createHmac('sha256', Buffer.from(secret, 'hex'))
        .update(`${timestamp}.${body}`, 'utf8')
        .digest('hex');

      expect(signer.sign(secret, body, timestamp)).toBe(
        `t=${timestamp},v1=${expected}`,
      );
    });

    it('is deterministic for the same timestamp and body', () => {
      const secret = signer.generateSecret();
      expect(signer.sign(secret, 'x', 100)).toBe(signer.sign(secret, 'x', 100));
    });

    it('changes when the body changes by one byte', () => {
      const secret = signer.generateSecret();
      expect(signer.sign(secret, '{"a":1}', 100)).not.toBe(
        signer.sign(secret, '{"a":2}', 100),
      );
    });
  });

  describe('merchant-side verification', () => {
    it('accepts a freshly signed payload', () => {
      const secret = signer.generateSecret();
      const body = JSON.stringify({ id: 'evt_1', type: 'payment.completed' });
      const header = signer.sign(secret, body);

      expect(verifyWebhookSignature(header, secret, body)).toBe(true);
    });

    it('rejects a tampered body', () => {
      const secret = signer.generateSecret();
      const header = signer.sign(secret, '{"amount":"10.00"}');

      expect(verifyWebhookSignature(header, secret, '{"amount":"99.00"}')).toBe(
        false,
      );
    });

    it('rejects a signature made with a different secret', () => {
      const body = '{"id":"evt_1"}';
      const header = signer.sign(signer.generateSecret(), body);

      expect(
        verifyWebhookSignature(header, signer.generateSecret(), body),
      ).toBe(false);
    });

    it('rejects a timestamp older than the tolerance window', () => {
      const secret = signer.generateSecret();
      const body = '{"id":"evt_1"}';
      const stale = Math.floor(Date.now() / 1000) - 10 * 60;
      const header = signer.sign(secret, body, stale);

      expect(verifyWebhookSignature(header, secret, body)).toBe(false);
    });
  });

  describe('buildHeaders', () => {
    it('includes signature, event id, delivery id, and JSON content type', () => {
      const headers = signer.buildHeaders({
        secret: signer.generateSecret(),
        body: '{"id":"evt_1"}',
        eventId: 'evt_1',
        deliveryId: 'whd_1',
      });

      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['Hypertron-Event-Id']).toBe('evt_1');
      expect(headers['Hypertron-Delivery-Id']).toBe('whd_1');
      expect(headers['Hypertron-Signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    });
  });

  describe('secret encryption', () => {
    it('round-trips a signing secret', () => {
      const secret = signer.generateSecret();
      expect(signer.decrypt(signer.encrypt(secret))).toBe(secret);
    });

    it('never stores the plaintext in the envelope', () => {
      const secret = signer.generateSecret();
      expect(signer.encrypt(secret)).not.toContain(secret);
    });

    it('produces a different envelope each time (random IV)', () => {
      const secret = signer.generateSecret();
      expect(signer.encrypt(secret)).not.toBe(signer.encrypt(secret));
    });

    it('throws a safe ApiException on a tampered envelope', () => {
      const envelope = signer.encrypt(signer.generateSecret());
      const tampered = `${envelope.slice(0, -2)}00`;

      expect(() => signer.decrypt(tampered)).toThrow(ApiException);
    });

    it('throws when decrypting with a different master key', () => {
      const envelope = signer.encrypt(signer.generateSecret());
      expect(() => signerWith('c'.repeat(64)).decrypt(envelope)).toThrow(
        ApiException,
      );
    });

    it('rejects a malformed WEBHOOK_SECRET_ENCRYPTION_KEY', () => {
      expect(() => signerWith('too-short').encrypt('secret')).toThrow(
        ApiException,
      );
    });
  });
});

describe('retry policy', () => {
  it('retries 5xx, 408, 409, 425, and 429', () => {
    for (const status of [408, 409, 425, 429, 500, 502, 503, 504]) {
      expect(isRetryableStatus(status)).toBe(true);
    }
  });

  it('does not retry other 4xx responses', () => {
    for (const status of [400, 401, 403, 404, 410, 422]) {
      expect(isRetryableStatus(status)).toBe(false);
    }
  });

  it('follows the 30s, 2m, 10m, 1h, 6h, 24h schedule', () => {
    expect(RETRY_DELAYS_MS).toEqual([
      30_000, 120_000, 600_000, 3_600_000, 21_600_000, 86_400_000,
    ]);

    expect(retryDelayMs(1)).toBe(30_000);
    expect(retryDelayMs(2)).toBe(120_000);
    expect(retryDelayMs(3)).toBe(600_000);
    expect(retryDelayMs(4)).toBe(3_600_000);
    expect(retryDelayMs(5)).toBe(21_600_000);
    expect(retryDelayMs(6)).toBe(86_400_000);
  });

  it('exhausts after the seventh attempt', () => {
    expect(retryDelayMs(MAX_DELIVERY_ATTEMPTS)).toBeNull();
    expect(retryDelayMs(MAX_DELIVERY_ATTEMPTS + 1)).toBeNull();
  });
});
