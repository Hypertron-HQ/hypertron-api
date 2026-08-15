/**
 * Response shapes for webhook endpoints.
 *
 * SECURITY: `signing_secret` is non-null only on create and rotate-secret.
 * `signingSecretEncrypted` is never serialised.
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { WebhookEndpoint } from '@prisma/client';

export class WebhookEndpointResponseDto {
  @ApiProperty({ example: 'we_01J...' })
  id!: string;

  @ApiProperty({ example: 'webhook_endpoint' })
  object = 'webhook_endpoint';

  @ApiProperty({ example: 'https://merchant.example.com/hypertron/webhook' })
  url!: string;

  @ApiProperty({ enum: ['test', 'live'], example: 'test' })
  environment!: string;

  @ApiProperty({ example: ['payment.completed'], isArray: true })
  events!: string[];

  @ApiPropertyOptional({ example: 'Production order updates', nullable: true })
  description!: string | null;

  @ApiProperty({ example: true })
  active!: boolean;

  @ApiProperty({ example: 'a1b2' })
  secret_last_four!: string;

  @ApiPropertyOptional({
    description:
      'Raw signing secret — returned only once, on create and rotate-secret.',
    nullable: true,
  })
  signing_secret!: string | null;

  @ApiProperty({ example: '2026-08-03T12:30:00.000Z' })
  created_at!: string;

  @ApiProperty({ example: '2026-08-03T12:30:00.000Z' })
  updated_at!: string;

  @ApiPropertyOptional({ example: null, nullable: true })
  disabled_at!: string | null;
}

export class WebhookEndpointListResponseDto {
  @ApiProperty({ example: 'list' })
  object = 'list';

  @ApiProperty({ type: [WebhookEndpointResponseDto] })
  data!: WebhookEndpointResponseDto[];
}

export class DeletedWebhookEndpointResponseDto {
  @ApiProperty({ example: 'we_01J...' })
  id!: string;

  @ApiProperty({ example: 'webhook_endpoint' })
  object = 'webhook_endpoint';

  @ApiProperty({ example: true })
  deleted = true;
}

/**
 * @param signingSecret Pass the raw secret ONLY on create/rotate responses.
 */
export function toWebhookEndpointResponse(
  record: WebhookEndpoint,
  signingSecret: string | null = null,
): WebhookEndpointResponseDto {
  const dto = new WebhookEndpointResponseDto();
  dto.id = record.publicId;
  dto.url = record.url;
  dto.environment = record.environment;
  dto.events = record.events;
  dto.description = record.description ?? null;
  dto.active = record.active;
  dto.secret_last_four = record.secretLastFour;
  dto.signing_secret = signingSecret;
  dto.created_at = record.createdAt.toISOString();
  dto.updated_at = record.updatedAt.toISOString();
  dto.disabled_at = record.disabledAt?.toISOString() ?? null;
  return dto;
}

export function toWebhookEndpointListResponse(
  records: WebhookEndpoint[],
): WebhookEndpointListResponseDto {
  const dto = new WebhookEndpointListResponseDto();
  dto.data = records.map((record) => toWebhookEndpointResponse(record, null));
  return dto;
}

export function toDeletedWebhookEndpointResponse(
  record: WebhookEndpoint,
): DeletedWebhookEndpointResponseDto {
  const dto = new DeletedWebhookEndpointResponseDto();
  dto.id = record.publicId;
  return dto;
}
