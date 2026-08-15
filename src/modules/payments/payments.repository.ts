/**
 * PaymentsRepository — data access for Payment documents.
 *
 * All methods accept businessId (and usually environment) to enforce
 * cross-merchant isolation. Returns 404-safe nulls — never throws HTTP errors.
 */

import { Injectable } from '@nestjs/common';
import type { Payment } from '@prisma/client';
import { PaymentStatus, type Environment } from '@prisma/client';
import { PrismaService } from '@/infrastructure/prisma/prisma.service';

export interface CreatePaymentInput {
  publicId: string;
  businessId: string;
  environment: Environment;
  amount: string;
  currency: string;
  description?: string | null;
  customerId?: string | null;
  metadata?: Record<string, string>;
  checkoutUrl: string;
  checkoutLinkId: string;
  linkMemo: string;
  destinationAddress: string;
  expiresAt?: Date | null;
}

export interface CursorPage<T> {
  data: T[];
  hasMore: boolean;
  nextCursor: string | null;
}

// ─── Cursor helpers ───────────────────────────────────────────────────────────

/** Encodes a cursor from createdAt + internal id (opaque to clients). */
export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(
    JSON.stringify({ t: createdAt.toISOString(), id }),
    'utf8',
  ).toString('base64url');
}

/** Decodes a cursor. Returns null if malformed. */
export function decodeCursor(
  cursor: string,
): { createdAt: Date; id: string } | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(raw) as { t: string; id: string };
    if (!parsed.t || !parsed.id) return null;
    return { createdAt: new Date(parsed.t), id: parsed.id };
  } catch {
    return null;
  }
}

@Injectable()
export class PaymentsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Creates a new payment record. */
  async create(input: CreatePaymentInput): Promise<Payment> {
    return this.prisma.payment.create({
      data: {
        publicId: input.publicId,
        businessId: input.businessId,
        environment: input.environment,
        amount: input.amount,
        currency: input.currency as import('@prisma/client').PaymentCurrency,
        description: input.description ?? null,
        customerId: input.customerId ?? null,
        metadata: (input.metadata as object) ?? {},
        checkoutUrl: input.checkoutUrl,
        checkoutLinkId: input.checkoutLinkId,
        linkMemo: input.linkMemo,
        destinationAddress: input.destinationAddress,
        expiresAt: input.expiresAt ?? null,
        status: PaymentStatus.created,
      },
    });
  }

  /** Finds a payment by publicId, scoped to businessId + environment. */
  async findByPublicId(
    publicId: string,
    businessId: string,
    environment: Environment,
  ): Promise<Payment | null> {
    return this.prisma.payment.findFirst({
      where: { publicId, businessId, environment },
    });
  }

  /**
   * Cursor-paginated list of payments for a merchant.
   * Returns limit+1 rows to determine has_more.
   */
  async findAll(params: {
    businessId: string;
    environment: Environment;
    limit: number;
    cursor?: { createdAt: Date; id: string } | null;
  }): Promise<CursorPage<Payment>> {
    const { businessId, environment, limit, cursor } = params;
    const take = limit + 1; // fetch one extra to detect has_more

    const rows = await this.prisma.payment.findMany({
      where: {
        businessId,
        environment,
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
    });

    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const lastRow = data[data.length - 1];
    const nextCursor =
      hasMore && lastRow ? encodeCursor(lastRow.createdAt, lastRow.id) : null;

    return { data, hasMore, nextCursor };
  }
}
