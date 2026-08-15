/**
 * Payment response shape and list envelope.
 * Matches the Payments_API_v1_Schema.md contract.
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { Payment, PaymentEvent } from '@prisma/client';

// ─── Single payment ───────────────────────────────────────────────────────────

export class PaymentResponseDto {
  @ApiProperty({ example: 'pay_01JABC123' })
  id!: string;

  @ApiProperty({ example: 'payment', enum: ['payment'] })
  object!: 'payment';

  @ApiProperty({ example: 'clxyz...' })
  business_id!: string;

  @ApiProperty({ enum: ['test', 'live'], example: 'test' })
  environment!: string;

  @ApiProperty({
    enum: [
      'created',
      'pending',
      'confirmed',
      'completed',
      'failed',
      'expired',
      'canceled',
    ],
    example: 'pending',
  })
  status!: string;

  @ApiProperty({ example: '100.00', description: 'Decimal string amount' })
  amount!: string;

  @ApiProperty({ enum: ['USDC', 'EURC', 'XLM'], example: 'USDC' })
  currency!: string;

  @ApiPropertyOptional({ example: 'Order ORD123', nullable: true })
  description!: string | null;

  @ApiPropertyOptional({ example: 'cus_01JABC456', nullable: true })
  customer_id!: string | null;

  @ApiProperty({
    example: { order_id: 'ORD123' },
    additionalProperties: true,
  })
  metadata!: Record<string, unknown>;

  @ApiProperty({ example: 'https://pay.hypertron.xyz/pay/...' })
  checkout_url!: string;

  @ApiProperty({ example: 'hpl_abc123' })
  link_memo!: string;

  @ApiProperty({ example: 'G...' })
  destination_address!: string;

  @ApiPropertyOptional({ example: 'G...', nullable: true })
  payer_address!: string | null;

  @ApiPropertyOptional({ example: 'a1b2c3...', nullable: true })
  transaction_hash!: string | null;

  @ApiPropertyOptional({ example: 'wrong_asset', nullable: true })
  failure_code!: string | null;

  @ApiPropertyOptional({ example: 'Asset code mismatch', nullable: true })
  failure_message!: string | null;

  @ApiPropertyOptional({ example: '2026-08-03T13:30:00.000Z', nullable: true })
  expires_at!: string | null;

  @ApiPropertyOptional({ example: '2026-08-03T12:31:00.000Z', nullable: true })
  paid_at!: string | null;

  @ApiPropertyOptional({ example: '2026-08-03T12:31:10.000Z', nullable: true })
  completed_at!: string | null;

  @ApiPropertyOptional({ example: null, nullable: true })
  canceled_at!: string | null;

  @ApiProperty({ example: '2026-08-03T12:30:00.000Z' })
  created_at!: string;

  @ApiProperty({ example: '2026-08-03T12:30:00.000Z' })
  updated_at!: string;
}

export function toPaymentResponse(payment: Payment): PaymentResponseDto {
  const dto = new PaymentResponseDto();
  dto.id = payment.publicId;
  dto.object = 'payment';
  dto.business_id = payment.businessId;
  dto.environment = payment.environment;
  dto.status = payment.status;
  dto.amount = payment.amount;
  dto.currency = payment.currency;
  dto.description = payment.description ?? null;
  dto.customer_id = payment.customerId ?? null;
  dto.metadata = (payment.metadata as Record<string, unknown>) ?? {};
  dto.checkout_url = payment.checkoutUrl;
  dto.link_memo = payment.linkMemo;
  dto.destination_address = payment.destinationAddress;
  dto.payer_address = payment.payerAddress ?? null;
  dto.transaction_hash = payment.transactionHash ?? null;
  dto.failure_code = payment.failureCode ?? null;
  dto.failure_message = payment.failureMessage ?? null;
  dto.expires_at = payment.expiresAt?.toISOString() ?? null;
  dto.paid_at = payment.paidAt?.toISOString() ?? null;
  dto.completed_at = payment.completedAt?.toISOString() ?? null;
  dto.canceled_at = payment.canceledAt?.toISOString() ?? null;
  dto.created_at = payment.createdAt.toISOString();
  dto.updated_at = payment.updatedAt.toISOString();
  return dto;
}

// ─── Paginated list ───────────────────────────────────────────────────────────

export class PaymentListResponseDto {
  @ApiProperty({ example: 'list', enum: ['list'] })
  object!: 'list';

  @ApiProperty({ type: [PaymentResponseDto] })
  data!: PaymentResponseDto[];

  @ApiProperty({ example: false })
  has_more!: boolean;

  @ApiPropertyOptional({ example: null, nullable: true })
  next_cursor!: string | null;
}

export function toPaymentListResponse(
  payments: Payment[],
  hasMore: boolean,
  nextCursor: string | null,
): PaymentListResponseDto {
  const dto = new PaymentListResponseDto();
  dto.object = 'list';
  dto.data = payments.map(toPaymentResponse);
  dto.has_more = hasMore;
  dto.next_cursor = nextCursor;
  return dto;
}

// ─── Payment event response ───────────────────────────────────────────────────

export class PaymentEventResponseDto {
  @ApiProperty({ example: 'evt_01JABC789' })
  id!: string;

  @ApiProperty({ example: 'payment_event', enum: ['payment_event'] })
  object!: 'payment_event';

  @ApiProperty({
    description: 'Internal payment ObjectId (opaque to merchants in v1 list)',
    example: '665f...',
  })
  payment_id!: string;

  @ApiProperty({
    example: 'payment.completed',
    enum: [
      'payment.created',
      'payment.pending',
      'payment.confirmed',
      'payment.completed',
      'payment.failed',
      'payment.expired',
      'payment.canceled',
    ],
  })
  type!: string;

  @ApiProperty({
    description: 'Immutable payment snapshot at event emission time',
    additionalProperties: true,
  })
  data!: Record<string, unknown>;

  @ApiProperty({ example: '2026-08-03T12:31:10.000Z' })
  created_at!: string;
}

export function toPaymentEventResponse(
  evt: PaymentEvent,
): PaymentEventResponseDto {
  const dto = new PaymentEventResponseDto();
  dto.id = evt.publicId;
  dto.object = 'payment_event';
  dto.payment_id = evt.paymentId;
  dto.type = evt.type;
  dto.data = evt.data as Record<string, unknown>;
  dto.created_at = evt.createdAt.toISOString();
  return dto;
}

export class PaymentEventListResponseDto {
  @ApiProperty({ example: 'list', enum: ['list'] })
  object!: 'list';

  @ApiProperty({ type: [PaymentEventResponseDto] })
  data!: PaymentEventResponseDto[];
}

export function toPaymentEventListResponse(
  events: PaymentEvent[],
): PaymentEventListResponseDto {
  const dto = new PaymentEventListResponseDto();
  dto.object = 'list';
  dto.data = events.map(toPaymentEventResponse);
  return dto;
}
