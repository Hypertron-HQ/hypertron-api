/**
 * Customer response shape and list envelope.
 * Matches the Payments_API_v1_Schema.md contract.
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { Customer } from '@prisma/client';
import { encodeCursor } from '@/modules/payments/payments.repository';

// ─── Single customer ──────────────────────────────────────────────────────────

export class CustomerResponseDto {
  @ApiProperty({ example: 'cus_01JABC456' })
  id!: string;

  @ApiProperty({ example: 'customer', enum: ['customer'] })
  object!: 'customer';

  @ApiProperty({ example: 'clxyz...' })
  business_id!: string;

  @ApiPropertyOptional({ example: 'customer@example.com', nullable: true })
  email!: string | null;

  @ApiPropertyOptional({ example: 'Ada Lovelace', nullable: true })
  name!: string | null;

  @ApiProperty({
    example: { crm_id: 'crm_123' },
    additionalProperties: true,
  })
  metadata!: Record<string, unknown>;

  @ApiProperty({ example: 3 })
  payment_count!: number;

  @ApiProperty({ example: '250.00', description: 'Decimal string' })
  lifetime_value!: string;

  @ApiProperty({ example: 'USDC' })
  lifetime_value_currency!: string;

  @ApiPropertyOptional({ example: '2026-08-03T12:31:10.000Z', nullable: true })
  last_payment_at!: string | null;

  @ApiProperty({ example: '2026-07-01T10:00:00.000Z' })
  created_at!: string;

  @ApiProperty({ example: '2026-08-03T12:31:10.000Z' })
  updated_at!: string;
}

export function toCustomerResponse(customer: Customer): CustomerResponseDto {
  const dto = new CustomerResponseDto();
  dto.id = customer.publicId;
  dto.object = 'customer';
  dto.business_id = customer.businessId;
  dto.email = customer.email ?? null;
  dto.name = customer.name ?? null;
  dto.metadata = (customer.metadata as Record<string, unknown>) ?? {};
  dto.payment_count = customer.paymentCount;
  dto.lifetime_value = customer.lifetimeValue;
  dto.lifetime_value_currency = customer.lifetimeValueCurrency;
  dto.last_payment_at = customer.lastPaymentAt?.toISOString() ?? null;
  dto.created_at = customer.createdAt.toISOString();
  dto.updated_at = customer.updatedAt.toISOString();
  return dto;
}

// ─── Paginated list ───────────────────────────────────────────────────────────

export class CustomerListResponseDto {
  @ApiProperty({ example: 'list', enum: ['list'] })
  object!: 'list';

  @ApiProperty({ type: [CustomerResponseDto] })
  data!: CustomerResponseDto[];

  @ApiProperty({ example: false })
  has_more!: boolean;

  @ApiPropertyOptional({ example: null, nullable: true })
  next_cursor!: string | null;
}

export function toCustomerListResponse(
  customers: Customer[],
  hasMore: boolean,
  nextCursor: string | null,
): CustomerListResponseDto {
  const dto = new CustomerListResponseDto();
  dto.object = 'list';
  dto.data = customers.map(toCustomerResponse);
  dto.has_more = hasMore;
  dto.next_cursor = nextCursor;
  return dto;
}

/**
 * Builds cursor + has_more from a raw rows array.
 * Caller fetches limit+1 rows; this slices and computes.
 */
export function buildCustomerPage(
  rows: Customer[],
  limit: number,
): { data: Customer[]; hasMore: boolean; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];
  const nextCursor =
    hasMore && last ? encodeCursor(last.createdAt, last.id) : null;
  return { data, hasMore, nextCursor };
}
