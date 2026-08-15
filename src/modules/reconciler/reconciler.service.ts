/**
 * ReconcilerService — drives PaymentStateMachine from Horizon matches (Plan §12).
 *
 * Responsibilities:
 *  - poll open (pending) Dev API Payments
 *  - verify classic Horizon payments via StellarVerifier
 *  - pending → confirmed → (finality) → completed
 *  - sync CheckoutLink paidAt / paymentTxHash (A4)
 *  - update customer aggregates after completion
 *  - expire created/pending payments past expiresAt
 *
 * Dashboard Collect PaymentLinks are reconciled in hypertron-core-backend.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PaymentStatus } from '@prisma/client';
import type { Payment } from '@prisma/client';

import { PrismaService } from '@/infrastructure/prisma/prisma.service';
import { StellarHorizonService } from '@/infrastructure/stellar/stellar-horizon.service';
import { CircuitOpenError } from '@/infrastructure/stellar/circuit-breaker';
import { PaymentStateMachine } from '@/modules/payments/payment-state-machine';
import { addDecimalStrings } from '@/common/utils/amount.util';
import type { StellarConfig } from '@/common/config/stellar.config';
import { StateTransitionException } from '@/common/exceptions/hypertron.exception';

import { StellarVerifier } from './stellar-verifier';
import {
  RECONCILER_QUEUE,
  JOB_FINALITY_CHECK,
  type FinalityCheckJob,
} from './reconciler.constants';

export type ReconcileOutcome =
  | 'confirmed'
  | 'completed'
  | 'failed'
  | 'expired'
  | 'skipped'
  | 'no_match'
  | 'horizon_unavailable';

@Injectable()
export class ReconcilerService {
  private readonly logger = new Logger(ReconcilerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly horizon: StellarHorizonService,
    private readonly verifier: StellarVerifier,
    private readonly stateMachine: PaymentStateMachine,
    private readonly config: ConfigService,
    @InjectQueue(RECONCILER_QUEUE) private readonly queue: Queue,
  ) {}

  /**
   * Cron entry: reconcile Dev API pending Payments.
   * Collect (dashboard) links are owned by hypertron-core-backend.
   */
  async pollOpenPayments(): Promise<{
    processed: number;
    outcomes: Record<string, number>;
  }> {
    const open = await this.prisma.payment.findMany({
      where: { status: PaymentStatus.pending },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });

    const outcomes: Record<string, number> = {};
    for (const payment of open) {
      // Expire first if wall-clock passed
      if (payment.expiresAt && payment.expiresAt.getTime() < Date.now()) {
        await this.expirePayment(payment);
        outcomes.expired = (outcomes.expired ?? 0) + 1;
        continue;
      }

      const result = await this.reconcilePayment(payment);
      outcomes[result] = (outcomes[result] ?? 0) + 1;
    }

    this.logger.log(
      {
        processed: open.length,
        outcomes,
      },
      'poll-open-payments finished',
    );
    return {
      processed: open.length,
      outcomes,
    };
  }

  /** Reconcile a single pending payment against Horizon. */
  async reconcilePayment(payment: Payment): Promise<ReconcileOutcome> {
    if (payment.status !== PaymentStatus.pending) {
      return 'skipped';
    }

    // Already attributed — another worker won the race
    if (payment.transactionHash) {
      return 'skipped';
    }

    const stellar = this.config.get<StellarConfig>('stellar')!;

    let records;
    try {
      records = await this.horizon.listPaymentsForAccount(
        payment.destinationAddress,
        payment.environment,
        stellar.reconcilerLookback,
      );
    } catch (err) {
      if (err instanceof CircuitOpenError) {
        this.logger.warn(
          { environment: payment.environment },
          'Horizon circuit open — skipping reconcile tick',
        );
        return 'horizon_unavailable';
      }
      this.logger.error(
        {
          paymentId: payment.publicId,
          err: err instanceof Error ? err.message : String(err),
        },
        'Horizon query failed',
      );
      return 'horizon_unavailable';
    }

    const knownHashes = await this.loadForeignHashes(
      records.map((r) => r.transactionHash),
      { excludePaymentId: payment.id },
    );

    const result = this.verifier.verify(
      {
        linkMemo: payment.linkMemo,
        destinationAddress: payment.destinationAddress,
        amount: payment.amount,
        currency: payment.currency,
        environment: payment.environment,
        expiresAt: payment.expiresAt,
      },
      records,
      knownHashes,
    );

    if (!result.ok) {
      if (result.code === 'no_match') return 'no_match';

      if (result.code === 'duplicate_hash') {
        this.logger.error(
          {
            paymentId: payment.publicId,
            tx: result.payment?.transactionHash,
          },
          'CRITICAL: duplicate transaction hash — skipping',
        );
        return 'skipped';
      }

      if (result.code === 'expired') {
        await this.expirePayment(payment);
        return 'expired';
      }

      if (
        result.code === 'wrong_asset' ||
        result.code === 'wrong_issuer' ||
        result.code === 'insufficient_amount' ||
        result.code === 'wrong_amount'
      ) {
        try {
          await this.stateMachine.toFailed(
            payment.id,
            result.code === 'wrong_issuer' ? 'wrong_asset' : result.code,
            result.message,
          );
          return 'failed';
        } catch (err) {
          if (err instanceof StateTransitionException) return 'skipped';
          throw err;
        }
      }

      return 'no_match';
    }

    // Match — confirm
    try {
      const confirmed = await this.stateMachine.toConfirmed(payment.id, {
        transactionHash: result.payment.transactionHash,
        payerAddress: result.payment.from,
        assetIssuer: result.payment.assetIssuer,
      });

      await this.syncCheckoutLink(confirmed);

      await this.enqueueFinalityCheck(confirmed);

      this.logger.log(
        {
          paymentId: confirmed.publicId,
          tx: result.payment.transactionHash,
        },
        'Payment confirmed from Horizon match',
      );
      return 'confirmed';
    } catch (err) {
      if (err instanceof StateTransitionException) return 'skipped';
      // Unique constraint on transactionHash — treat as duplicate
      if (isUniqueViolation(err)) {
        this.logger.error(
          {
            paymentId: payment.publicId,
            tx: result.payment.transactionHash,
          },
          'CRITICAL: transactionHash unique conflict — skipping',
        );
        return 'skipped';
      }
      throw err;
    }
  }

  /** Delayed finality job: re-verify tx still successful → completed. */
  async finalizePayment(paymentInternalId: string): Promise<ReconcileOutcome> {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentInternalId },
    });

    if (!payment) return 'skipped';
    if (payment.status === PaymentStatus.completed) return 'completed';
    if (payment.status !== PaymentStatus.confirmed) return 'skipped';
    if (!payment.transactionHash) return 'skipped';

    let tx;
    try {
      tx = await this.horizon.getTransaction(
        payment.transactionHash,
        payment.environment,
      );
    } catch (err) {
      if (err instanceof CircuitOpenError) return 'horizon_unavailable';
      throw err;
    }

    if (!tx || !tx.successful) {
      try {
        await this.stateMachine.toFailed(
          payment.id,
          'tx_unsuccessful',
          'Transaction no longer successful at finality check',
        );
        return 'failed';
      } catch (err) {
        if (err instanceof StateTransitionException) return 'skipped';
        throw err;
      }
    }

    try {
      const completed = await this.stateMachine.toCompleted(payment.id);
      await this.syncCheckoutLink(completed);
      await this.updateCustomerAggregates(completed);
      this.logger.log(
        { paymentId: completed.publicId },
        'Payment completed after finality',
      );
      return 'completed';
    } catch (err) {
      if (err instanceof StateTransitionException) return 'skipped';
      throw err;
    }
  }

  /** Expiry cron: mark created/pending past expiresAt as expired. */
  async expireOverduePayments(): Promise<number> {
    const now = new Date();
    const overdue = await this.prisma.payment.findMany({
      where: {
        status: { in: [PaymentStatus.created, PaymentStatus.pending] },
        expiresAt: { lt: now },
      },
      take: 200,
    });

    let count = 0;
    for (const payment of overdue) {
      const ok = await this.expirePayment(payment);
      if (ok) count += 1;
    }

    if (count > 0) {
      this.logger.log({ count }, 'Expired overdue payments');
    }
    return count;
  }

  private async expirePayment(payment: Payment): Promise<boolean> {
    try {
      await this.stateMachine.toExpired(payment.id);
      return true;
    } catch (err) {
      if (err instanceof StateTransitionException) return false;
      throw err;
    }
  }

  private async enqueueFinalityCheck(payment: Payment): Promise<void> {
    const stellar = this.config.get<StellarConfig>('stellar')!;
    const data: FinalityCheckJob = { paymentInternalId: payment.id };
    await this.queue.add(JOB_FINALITY_CHECK, data, {
      jobId: `finality_${payment.id}`,
      delay: stellar.finalityDelayMs,
      removeOnComplete: true,
      removeOnFail: 100,
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
    });
  }

  private async syncCheckoutLink(payment: Payment): Promise<void> {
    if (!payment.checkoutLinkId || !payment.transactionHash) return;

    await this.prisma.checkoutLink.update({
      where: { id: payment.checkoutLinkId },
      data: {
        paymentTxHash: payment.transactionHash,
        paidAt: payment.paidAt ?? new Date(),
      },
    });
  }

  private async updateCustomerAggregates(payment: Payment): Promise<void> {
    if (!payment.customerId) return;

    // v1: lifetimeValue is USDC-denominated; only increment for USDC
    const customer = await this.prisma.customer.findUnique({
      where: { id: payment.customerId },
    });
    if (!customer) return;

    const data: {
      paymentCount: { increment: number };
      lastPaymentAt: Date;
      lifetimeValue?: string;
    } = {
      paymentCount: { increment: 1 },
      lastPaymentAt: payment.completedAt ?? new Date(),
    };

    if (payment.currency === 'USDC') {
      data.lifetimeValue = addDecimalStrings(
        customer.lifetimeValue || '0',
        payment.amount,
      );
    }

    await this.prisma.customer.update({
      where: { id: payment.customerId },
      data,
    });
  }

  private async loadForeignHashes(
    hashes: string[],
    opts?: { excludePaymentId?: string },
  ): Promise<Set<string>> {
    if (hashes.length === 0) return new Set();
    const unique = [...new Set(hashes)];

    const paymentRows = await this.prisma.payment.findMany({
      where: {
        transactionHash: { in: unique },
        ...(opts?.excludePaymentId
          ? { NOT: { id: opts.excludePaymentId } }
          : {}),
      },
      select: { transactionHash: true },
    });

    const out = new Set<string>();
    for (const r of paymentRows) {
      if (r.transactionHash) out.add(r.transactionHash);
    }
    return out;
  }
}

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: string }).code;
  // Prisma Mongo unique / Prisma P2002
  return code === 'P2002';
}
