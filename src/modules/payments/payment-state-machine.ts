/**
 * PaymentStateMachine — all valid lifecycle transitions for a Payment.
 *
 * Spec section 11.2:
 *  created  → pending   → confirmed → completed (terminal)
 *  created  → canceled  (terminal)
 *  pending  → canceled  (terminal)
 *  pending  → failed    (terminal)
 *  pending  → expired   (terminal)
 *  confirmed→ failed    (terminal)
 *
 * Each transition:
 *  1. Validates the from-state is allowed (throws 409 StateTransitionException)
 *  2. Atomic compare-and-set via updateMany — returns count=0 if race lost
 *  3. Sets lifecycle timestamp (paidAt, completedAt, canceledAt, etc.)
 *  4. Emits the corresponding PaymentEvent via EventsService
 *  5. Returns the updated Payment
 */

import { Injectable, Logger } from '@nestjs/common';
import type { Payment } from '@prisma/client';
import { PaymentStatus } from '@prisma/client';

import { PrismaService } from '@/infrastructure/prisma/prisma.service';
import { EventsService } from '@/modules/events/events.service';
import { StateTransitionException } from '@/common/exceptions/hypertron.exception';

// ─── Allowed from-states per transition ──────────────────────────────────────

const ALLOWED_FROM: Record<string, PaymentStatus[]> = {
  pending: [PaymentStatus.created],
  confirmed: [PaymentStatus.pending],
  completed: [PaymentStatus.confirmed],
  failed: [PaymentStatus.pending, PaymentStatus.confirmed],
  expired: [PaymentStatus.created, PaymentStatus.pending],
  canceled: [PaymentStatus.created, PaymentStatus.pending],
};

// ─── TransactionData for confirmed transition ─────────────────────────────────

export interface TransactionData {
  transactionHash: string;
  payerAddress: string;
  assetIssuer?: string | null;
}

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class PaymentStateMachine {
  private readonly logger = new Logger(PaymentStateMachine.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
  ) {}

  // ─── created → pending ──────────────────────────────────────────────────────

  async toPending(paymentInternalId: string): Promise<Payment> {
    return this.transition({
      paymentInternalId,
      fromStates: ALLOWED_FROM.pending,
      toStatus: PaymentStatus.pending,
      extraData: {},
      eventType: 'payment.pending',
    });
  }

  // ─── pending → confirmed ───────────────────────────────────────────────────

  async toConfirmed(
    paymentInternalId: string,
    tx: TransactionData,
  ): Promise<Payment> {
    // CAS is status=pending only. Do NOT filter `transactionHash: null` here:
    // Prisma/Mongo often omits unset optional fields, so `{ transactionHash: null }`
    // matches 0 rows and the reconciler would skip forever after a Horizon match.
    // Duplicate hashes are blocked by the unique index on transactionHash.
    return this.transition({
      paymentInternalId,
      fromStates: ALLOWED_FROM.confirmed,
      toStatus: PaymentStatus.confirmed,
      extraData: {
        transactionHash: tx.transactionHash,
        payerAddress: tx.payerAddress,
        assetIssuer: tx.assetIssuer ?? null,
        paidAt: new Date(),
      },
      eventType: 'payment.confirmed',
    });
  }

  // ─── confirmed → completed ─────────────────────────────────────────────────

  async toCompleted(paymentInternalId: string): Promise<Payment> {
    return this.transition({
      paymentInternalId,
      fromStates: ALLOWED_FROM.completed,
      toStatus: PaymentStatus.completed,
      extraData: { completedAt: new Date() },
      eventType: 'payment.completed',
    });
  }

  // ─── pending|confirmed → failed ────────────────────────────────────────────

  async toFailed(
    paymentInternalId: string,
    failureCode: string,
    failureMessage: string,
  ): Promise<Payment> {
    return this.transition({
      paymentInternalId,
      fromStates: ALLOWED_FROM.failed,
      toStatus: PaymentStatus.failed,
      extraData: { failureCode, failureMessage },
      eventType: 'payment.failed',
    });
  }

  // ─── created|pending → expired ─────────────────────────────────────────────

  async toExpired(paymentInternalId: string): Promise<Payment> {
    return this.transition({
      paymentInternalId,
      fromStates: ALLOWED_FROM.expired,
      toStatus: PaymentStatus.expired,
      extraData: {},
      eventType: 'payment.expired',
    });
  }

  // ─── created|pending → canceled ────────────────────────────────────────────

  async toCanceled(paymentInternalId: string): Promise<Payment> {
    return this.transition({
      paymentInternalId,
      fromStates: ALLOWED_FROM.canceled,
      toStatus: PaymentStatus.canceled,
      extraData: { canceledAt: new Date() },
      eventType: 'payment.canceled',
    });
  }

  // ─── Core compare-and-set engine ──────────────────────────────────────────

  private async transition(params: {
    paymentInternalId: string;
    fromStates: PaymentStatus[];
    toStatus: PaymentStatus;
    extraData: Partial<Payment>;
    eventType: string;
    whereExtra?: Record<string, unknown>;
  }): Promise<Payment> {
    const {
      paymentInternalId,
      fromStates,
      toStatus,
      extraData,
      eventType,
      whereExtra,
    } = params;

    // 1. Load current payment to check state
    const current = await this.prisma.payment.findUnique({
      where: { id: paymentInternalId },
    });

    if (!current) {
      throw new StateTransitionException('(not found)', toStatus, 'payment');
    }

    if (!fromStates.includes(current.status)) {
      throw new StateTransitionException(current.status, toStatus, 'payment');
    }

    // 2. Atomic compare-and-set — only update if still in an allowed from-state
    const result = await this.prisma.payment.updateMany({
      where: {
        id: paymentInternalId,
        status: { in: fromStates },
        ...(whereExtra ?? {}),
      },
      data: { status: toStatus, ...(extraData as object) },
    });

    if (result.count === 0) {
      // Race condition — another process won; reload and check
      const reloaded = await this.prisma.payment.findUnique({
        where: { id: paymentInternalId },
      });
      if (reloaded && reloaded.status === toStatus) {
        // Idempotent — the desired state is already reached
        this.logger.warn(
          { paymentId: current.publicId, toStatus },
          'Transition no-op: already in target state',
        );
        return reloaded;
      }
      throw new StateTransitionException(current.status, toStatus, 'payment');
    }

    // 3. Reload to get the updated record
    const updated = await this.prisma.payment.findUnique({
      where: { id: paymentInternalId },
    });

    if (!updated) {
      throw new StateTransitionException(current.status, toStatus, 'payment');
    }

    // 4. Emit event
    await this.events.emit(updated, eventType);

    this.logger.log(
      { paymentId: updated.publicId, from: current.status, to: toStatus },
      `Payment transitioned: ${current.status} → ${toStatus}`,
    );

    return updated;
  }
}
