/**
 * Response shapes for webhook delivery observability.
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { WebhookDelivery } from '@prisma/client';

export class WebhookDeliveryResponseDto {
  @ApiProperty({ example: 'whd_01J...' })
  id!: string;

  @ApiProperty({ example: 'webhook_delivery' })
  object = 'webhook_delivery';

  @ApiProperty({ example: 'we_01J...' })
  endpoint_id!: string;

  @ApiProperty({ example: 'evt_01J...' })
  event_id!: string;

  @ApiProperty({
    enum: ['pending', 'delivered', 'failed'],
    example: 'delivered',
  })
  status!: string;

  @ApiProperty({ example: 1 })
  attempt_count!: number;

  @ApiPropertyOptional({ example: null, nullable: true })
  next_attempt_at!: string | null;

  @ApiPropertyOptional({ example: '2026-08-03T12:31:10.000Z', nullable: true })
  last_attempt_at!: string | null;

  @ApiPropertyOptional({ example: 200, nullable: true })
  response_status!: number | null;

  @ApiPropertyOptional({
    description: 'Truncated to 2 KB for debugging',
    nullable: true,
  })
  response_body!: string | null;

  @ApiPropertyOptional({ example: '2026-08-03T12:31:10.000Z', nullable: true })
  delivered_at!: string | null;

  @ApiProperty({ example: '2026-08-03T12:31:10.000Z' })
  created_at!: string;
}

export class WebhookDeliveryListResponseDto {
  @ApiProperty({ example: 'list' })
  object = 'list';

  @ApiProperty({ type: [WebhookDeliveryResponseDto] })
  data!: WebhookDeliveryResponseDto[];

  @ApiProperty({ example: false })
  has_more!: boolean;

  @ApiPropertyOptional({ example: null, nullable: true })
  next_cursor!: string | null;
}

export class TestWebhookResponseDto {
  @ApiProperty({ example: 'webhook_test' })
  object = 'webhook_test';

  @ApiProperty({ example: true })
  delivered!: boolean;

  @ApiPropertyOptional({ example: 200, nullable: true })
  response_status!: number | null;

  @ApiPropertyOptional({ nullable: true })
  response_body!: string | null;

  @ApiPropertyOptional({
    description: 'Transport error when no HTTP response was received',
    nullable: true,
  })
  error!: string | null;
}

export function toWebhookDeliveryResponse(
  record: WebhookDelivery,
  endpointPublicId: string,
): WebhookDeliveryResponseDto {
  const dto = new WebhookDeliveryResponseDto();
  dto.id = record.publicId;
  dto.endpoint_id = endpointPublicId;
  dto.event_id = record.eventId;
  dto.status = record.status;
  dto.attempt_count = record.attemptCount;
  dto.next_attempt_at = record.nextAttemptAt?.toISOString() ?? null;
  dto.last_attempt_at = record.lastAttemptAt?.toISOString() ?? null;
  dto.response_status = record.responseStatus ?? null;
  dto.response_body = record.responseBody ?? null;
  dto.delivered_at = record.deliveredAt?.toISOString() ?? null;
  dto.created_at = record.createdAt.toISOString();
  return dto;
}

export function toWebhookDeliveryListResponse(
  records: WebhookDelivery[],
  endpointPublicId: string,
  hasMore: boolean,
  nextCursor: string | null,
): WebhookDeliveryListResponseDto {
  const dto = new WebhookDeliveryListResponseDto();
  dto.data = records.map((record) =>
    toWebhookDeliveryResponse(record, endpointPublicId),
  );
  dto.has_more = hasMore;
  dto.next_cursor = nextCursor;
  return dto;
}
