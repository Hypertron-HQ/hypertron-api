/**
 * Payment response shape and list envelope.
 * Matches the Payments_API_v1_Schema.md contract.
 */

import type { Payment, PaymentEvent } from '@prisma/client';

// ─── Single payment ───────────────────────────────────────────────────────────

export interface PaymentResponseDto {
  id: string;
  object: 'payment';
  business_id: string;
  environment: string;
  status: string;
  amount: string;
  currency: string;
  description: string | null;
  customer_id: string | null;
  metadata: Record<string, unknown>;
  checkout_url: string;
  link_memo: string;
  destination_address: string;
  payer_address: string | null;
  transaction_hash: string | null;
  failure_code: string | null;
  failure_message: string | null;
  expires_at: string | null;
  paid_at: string | null;
  completed_at: string | null;
  canceled_at: string | null;
  created_at: string;
  updated_at: string;
}

export function toPaymentResponse(payment: Payment): PaymentResponseDto {
  return {
    id: payment.publicId,
    object: 'payment',
    business_id: payment.businessId,
    environment: payment.environment,
    status: payment.status,
    amount: payment.amount,
    currency: payment.currency,
    description: payment.description ?? null,
    customer_id: payment.customerId ?? null,
    metadata: (payment.metadata as Record<string, unknown>) ?? {},
    checkout_url: payment.checkoutUrl,
    link_memo: payment.linkMemo,
    destination_address: payment.destinationAddress,
    payer_address: payment.payerAddress ?? null,
    transaction_hash: payment.transactionHash ?? null,
    failure_code: payment.failureCode ?? null,
    failure_message: payment.failureMessage ?? null,
    expires_at: payment.expiresAt?.toISOString() ?? null,
    paid_at: payment.paidAt?.toISOString() ?? null,
    completed_at: payment.completedAt?.toISOString() ?? null,
    canceled_at: payment.canceledAt?.toISOString() ?? null,
    created_at: payment.createdAt.toISOString(),
    updated_at: payment.updatedAt.toISOString(),
  };
}

// ─── Paginated list ───────────────────────────────────────────────────────────

export interface PaymentListResponseDto {
  object: 'list';
  data: PaymentResponseDto[];
  has_more: boolean;
  next_cursor: string | null;
}

export function toPaymentListResponse(
  payments: Payment[],
  hasMore: boolean,
  nextCursor: string | null,
): PaymentListResponseDto {
  return {
    object: 'list',
    data: payments.map(toPaymentResponse),
    has_more: hasMore,
    next_cursor: nextCursor,
  };
}

// ─── Payment event response ───────────────────────────────────────────────────

export interface PaymentEventResponseDto {
  id: string;
  object: 'payment_event';
  payment_id: string;
  type: string;
  data: Record<string, unknown>;
  created_at: string;
}

export function toPaymentEventResponse(
  evt: PaymentEvent,
): PaymentEventResponseDto {
  return {
    id: evt.publicId,
    object: 'payment_event',
    payment_id: evt.paymentId,
    type: evt.type,
    data: evt.data as Record<string, unknown>,
    created_at: evt.createdAt.toISOString(),
  };
}

export interface PaymentEventListResponseDto {
  object: 'list';
  data: PaymentEventResponseDto[];
}

export function toPaymentEventListResponse(
  events: PaymentEvent[],
): PaymentEventListResponseDto {
  return { object: 'list', data: events.map(toPaymentEventResponse) };
}
