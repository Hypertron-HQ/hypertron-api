/**
 * WebhookEndpointService — endpoint CRUD with encrypted secret storage.
 *
 * Every method is scoped by businessId; a merchant can never read or mutate
 * another merchant's endpoint (missing rows surface as 404, not 403).
 */

import { Injectable, Logger } from '@nestjs/common';
import type { Environment, WebhookEndpoint } from '@prisma/client';

import { PrismaService } from '@/infrastructure/prisma/prisma.service';
import { generateId, PREFIXES } from '@/common/utils/id-generator';
import {
  InvalidRequestException,
  ResourceNotFoundException,
} from '@/common/exceptions/hypertron.exception';

import { WebhookSigner } from './webhook-signer';
import { isWebhookEventType, WEBHOOK_EVENT_TYPES } from './webhooks.constants';

export interface CreateEndpointInput {
  businessId: string;
  url: string;
  environment: Environment;
  events: string[];
  description?: string | null;
}

export interface UpdateEndpointInput {
  url?: string;
  events?: string[];
  description?: string | null;
  active?: boolean;
}

/** The plaintext secret is present only on create and rotate. */
export interface EndpointWithSecret {
  endpoint: WebhookEndpoint;
  signingSecret: string;
}

@Injectable()
export class WebhookEndpointService {
  private readonly logger = new Logger(WebhookEndpointService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly signer: WebhookSigner,
  ) {}

  async create(input: CreateEndpointInput): Promise<EndpointWithSecret> {
    const url = this.validateUrl(input.url, input.environment);
    const events = this.validateEvents(input.events);

    const signingSecret = this.signer.generateSecret();

    const endpoint = await this.prisma.webhookEndpoint.create({
      data: {
        publicId: generateId(PREFIXES.WEBHOOK_ENDPOINT),
        businessId: input.businessId,
        environment: input.environment,
        url,
        description: input.description ?? null,
        events,
        signingSecretEncrypted: this.signer.encrypt(signingSecret),
        secretLastFour: this.signer.lastFour(signingSecret),
        active: true,
      },
    });

    this.logger.log(
      {
        endpointId: endpoint.publicId,
        businessId: input.businessId,
        environment: input.environment,
      },
      'Webhook endpoint created',
    );

    return { endpoint, signingSecret };
  }

  async list(businessId: string): Promise<WebhookEndpoint[]> {
    return this.prisma.webhookEndpoint.findMany({
      // Dashboard listing deliberately spans test and live endpoints.
      where: { businessId, environment: { in: ['test', 'live'] } },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Throws 404 when the endpoint is missing or owned by another merchant. */
  async findOneOrThrow(
    publicId: string,
    businessId: string,
  ): Promise<WebhookEndpoint> {
    const endpoint = await this.prisma.webhookEndpoint.findFirst({
      where: { publicId, businessId },
    });

    if (!endpoint) {
      throw new ResourceNotFoundException('webhook_endpoint', publicId);
    }
    return endpoint;
  }

  async update(
    publicId: string,
    businessId: string,
    input: UpdateEndpointInput,
  ): Promise<WebhookEndpoint> {
    const existing = await this.findOneOrThrow(publicId, businessId);

    const data: Record<string, unknown> = {};

    if (input.url !== undefined) {
      data.url = this.validateUrl(input.url, existing.environment);
    }
    if (input.events !== undefined) {
      data.events = this.validateEvents(input.events);
    }
    if (input.description !== undefined) {
      data.description = input.description;
    }
    if (input.active !== undefined) {
      data.active = input.active;
      data.disabledAt = input.active ? null : new Date();
    }

    if (Object.keys(data).length === 0) {
      return existing;
    }

    const updated = await this.prisma.webhookEndpoint.update({
      where: { id: existing.id },
      data,
    });

    this.logger.log(
      { endpointId: publicId, fields: Object.keys(data) },
      'Webhook endpoint updated',
    );
    return updated;
  }

  async rotateSecret(
    publicId: string,
    businessId: string,
  ): Promise<EndpointWithSecret> {
    const existing = await this.findOneOrThrow(publicId, businessId);
    const signingSecret = this.signer.generateSecret();

    // In-flight deliveries re-read the secret at send time, so they pick up
    // the new value rather than signing with a stale one (Plan §21).
    const endpoint = await this.prisma.webhookEndpoint.update({
      where: { id: existing.id },
      data: {
        signingSecretEncrypted: this.signer.encrypt(signingSecret),
        secretLastFour: this.signer.lastFour(signingSecret),
      },
    });

    this.logger.log({ endpointId: publicId }, 'Webhook signing secret rotated');
    return { endpoint, signingSecret };
  }

  /** Deletes the endpoint and its delivery history. */
  async remove(publicId: string, businessId: string): Promise<WebhookEndpoint> {
    const existing = await this.findOneOrThrow(publicId, businessId);

    await this.prisma.webhookDelivery.deleteMany({
      where: { endpointId: existing.id },
    });
    await this.prisma.webhookEndpoint.delete({ where: { id: existing.id } });

    this.logger.log({ endpointId: publicId }, 'Webhook endpoint deleted');
    return existing;
  }

  // ─── Validation ─────────────────────────────────────────────────────────────

  /** HTTPS everywhere; plain HTTP to loopback is allowed for test endpoints. */
  private validateUrl(rawUrl: string, environment: Environment): string {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new InvalidRequestException(
        'invalid_webhook_url',
        'url must be a valid absolute URL.',
        'url',
      );
    }

    const isLoopback =
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '[::1]';

    if (parsed.protocol === 'https:') return parsed.toString();

    if (parsed.protocol === 'http:' && environment === 'test' && isLoopback) {
      return parsed.toString();
    }

    throw new InvalidRequestException(
      'invalid_webhook_url',
      'url must use https. Plain http is only allowed for localhost in the test environment.',
      'url',
    );
  }

  private validateEvents(events: string[]): string[] {
    const unique = [...new Set(events)];

    if (unique.length === 0) {
      throw new InvalidRequestException(
        'invalid_webhook_events',
        'events must contain at least one event type.',
        'events',
      );
    }

    const unknown = unique.filter((event) => !isWebhookEventType(event));
    if (unknown.length > 0) {
      throw new InvalidRequestException(
        'invalid_webhook_events',
        `Unknown event type(s): ${unknown.join(', ')}. Supported: ${WEBHOOK_EVENT_TYPES.join(', ')}.`,
        'events',
      );
    }

    return unique;
  }
}
