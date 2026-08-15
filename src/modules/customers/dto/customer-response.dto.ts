/**
 * Customer response shape and list envelope.
 * Matches the Payments_API_v1_Schema.md contract.
 */

import type { Customer } from '@prisma/client';
import { encodeCursor } from '@/modules/payments/payments.repository';

// ─── Single customer ──────────────────────────────────────────────────────────

export interface CustomerResponseDto {
  id: string;
  object: 'customer';
  business_id: string;
  email: string | null;
  name: string | null;
  metadata: Record<string, unknown>;
  payment_count: number;
  lifetime_value: string;
  lifetime_value_currency: string;
  last_payment_at: string | null;
  created_at: string;
  updated_at: string;
}

export function toCustomerResponse(customer: Customer): CustomerResponseDto {
  return {
    id: customer.publicId,
    object: 'customer',
    business_id: customer.businessId,
    email: customer.email ?? null,
    name: customer.name ?? null,
    metadata: (customer.metadata as Record<string, unknown>) ?? {},
    payment_count: customer.paymentCount,
    lifetime_value: customer.lifetimeValue,
    lifetime_value_currency: customer.lifetimeValueCurrency,
    last_payment_at: customer.lastPaymentAt?.toISOString() ?? null,
    created_at: customer.createdAt.toISOString(),
    updated_at: customer.updatedAt.toISOString(),
  };
}

// ─── Paginated list ───────────────────────────────────────────────────────────

export interface CustomerListResponseDto {
  object: 'list';
  data: CustomerResponseDto[];
  has_more: boolean;
  next_cursor: string | null;
}

export function toCustomerListResponse(
  customers: Customer[],
  hasMore: boolean,
  nextCursor: string | null,
): CustomerListResponseDto {
  return {
    object: 'list',
    data: customers.map(toCustomerResponse),
    has_more: hasMore,
    next_cursor: nextCursor,
  };
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
