/**
 * WebhookSigner — owns signing secrets end to end (Plan §9.6, §13.5).
 *
 * SECURITY: plaintext signing secrets exist only inside this service and the
 * single delivery call that consumes them. They are never logged, never cached
 * beyond a call, and never returned outside create/rotate responses.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  decryptSecret,
  encryptSecret,
  generateSigningSecret,
  signWebhookPayload,
} from '@/common/utils/crypto.util';
import { ApiException } from '@/common/exceptions/hypertron.exception';
import type { SecurityConfig } from '@/common/config/security.config';

export interface SignedHeaders extends Record<string, string> {
  'Content-Type': string;
  'User-Agent': string;
  'Hypertron-Signature': string;
  'Hypertron-Event-Id': string;
  'Hypertron-Delivery-Id': string;
}

@Injectable()
export class WebhookSigner {
  private readonly logger = new Logger(WebhookSigner.name);
  private cachedKey: Buffer | null = null;

  constructor(private readonly config: ConfigService) {}

  /** New 32-byte hex secret, returned to the merchant exactly once. */
  generateSecret(): string {
    return generateSigningSecret();
  }

  /** Safe display value stored alongside the encrypted secret. */
  lastFour(secret: string): string {
    return secret.slice(-4);
  }

  encrypt(secret: string): string {
    return encryptSecret(secret, this.encryptionKey());
  }

  decrypt(envelope: string): string {
    try {
      return decryptSecret(envelope, this.encryptionKey());
    } catch {
      // Never surface the underlying crypto error — it can leak key state.
      this.logger.error('Failed to decrypt webhook signing secret');
      throw new ApiException(
        'webhook_secret_undecryptable',
        'The stored signing secret could not be decrypted. Rotate the endpoint secret.',
      );
    }
  }

  /**
   * Returns the `Hypertron-Signature` value: `t=<unix_seconds>,v1=<hex_hmac>`
   * over `${timestamp}.${body}`.
   */
  sign(
    secret: string,
    body: string,
    timestamp: number = Math.floor(Date.now() / 1000),
  ): string {
    return signWebhookPayload(secret, timestamp, body);
  }

  buildHeaders(params: {
    secret: string;
    body: string;
    eventId: string;
    deliveryId: string;
    timestamp?: number;
  }): SignedHeaders {
    return {
      'Content-Type': 'application/json',
      'User-Agent': 'Hypertron-Webhooks/1.0',
      'Hypertron-Signature': this.sign(
        params.secret,
        params.body,
        params.timestamp,
      ),
      'Hypertron-Event-Id': params.eventId,
      'Hypertron-Delivery-Id': params.deliveryId,
    };
  }

  private encryptionKey(): Buffer {
    if (this.cachedKey) return this.cachedKey;

    const hex =
      this.config.get<SecurityConfig>('security')?.webhookSecretEncryptionKey ??
      '';

    if (!/^[0-9a-f]{64}$/i.test(hex)) {
      throw new ApiException(
        'webhook_encryption_key_invalid',
        'WEBHOOK_SECRET_ENCRYPTION_KEY must be a 32-byte hex string.',
      );
    }

    this.cachedKey = Buffer.from(hex, 'hex');
    return this.cachedKey;
  }
}
