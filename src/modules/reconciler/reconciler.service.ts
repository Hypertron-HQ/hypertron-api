/**
 * ReconcilerService — drives PaymentStateMachine from Horizon matches (Plan §12).
 *
 * Responsibilities:
 *  - poll open (pending) Dev API Payments
 *  - poll unpaid dashboard PaymentLinks (UI Collect) not owned by a pending Payment
 *  - verify classic Horizon payments via StellarVerifier
 *  - pending → confirmed → (finality) → completed
 *  - sync PaymentLink paidAt / paymentTxHash for dashboard
 *  - update customer aggregates after completion
 *  - expire created/pending payments past expiresAt
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PaymentStatus } from '@prisma/client';
import type { Environment, Payment, PaymentLink } from '@prisma/client';

import { PrismaService } from '@/infrastructure/prisma/prisma.service';
import {
  StellarHorizonService,
} from '@/infrastructure/stellar/stellar-horizon.service';
import { CircuitOpenError } from '@/infrastructure/stellar/circuit-breaker';
import { PaymentStateMachine } from '@/modules/payments/payment-state-machine';
import { addDecimalStrings } from '@/common/utils/amount.util';
import type { StellarConfig } from '@/common/config/stellar.config';
import type { AppConfig } from '@/common/config/app.config';
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
  | 'horizon_unavailable'
  | 'link_paid';

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
   * Cron entry: reconcile Dev API pending Payments, then unpaid UI PaymentLinks.
   */
  async pollOpenPayments(): Promise<{
    processed: number;
    outcomes: Record<string, number>;
    linksProcessed: number;
    linkOutcomes: Record<string, number>;
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

    const linkResult = await this.pollUnpaidPaymentLinks();

    this.logger.log(
      {
        processed: open.length,
        outcomes,
        linksProcessed: linkResult.processed,
        linkOutcomes: linkResult.outcomes,
      },
      'poll-open-payments finished',
    );
    return {
      processed: open.length,
      outcomes,
      linksProcessed: linkResult.processed,
      linkOutcomes: linkResult.outcomes,
    };
  }

  /**
   * Dashboard Collect links: PaymentLink rows with no paidAt, not already
   * owned by a pending/confirmed Dev API Payment.
   */
  async pollUnpaidPaymentLinks(): Promise<{
    processed: number;
    outcomes: Record<string, number>;
  }> {
    const now = new Date();
    // Keep the DB filter loose — Prisma/Mongo optional-null matching is unreliable.
    // Filter unpaid / classic / non-expired in process.
    const candidates = await this.prisma.paymentLink.findMany({
      orderBy: { createdAt: 'desc' },
      take: 300,
    });

    const openLinks = candidates.filter((link) => {
      if (link.paidAt || link.paymentTxHash) return false;
      if (!link.amount?.trim()) return false;
      if (!isClassicStellarAddress(link.destinationAddress)) return false;
      if (link.expiresAt && link.expiresAt.getTime() <= now.getTime()) return false;
      return true;
    }).slice(0, 200);

    // PaymentLinkIds already covered by an in-flight Dev API Payment
    const ownedLinkIds = new Set(
      openLinks.length === 0
        ? []
        : (
            await this.prisma.payment.findMany({
              where: {
                paymentLinkId: { in: openLinks.map((l) => l.id) },
                status: {
                  in: [
                    PaymentStatus.pending,
                    PaymentStatus.confirmed,
                    PaymentStatus.created,
                  ],
                },
              },
              select: { paymentLinkId: true },
            })
          ).map((p) => p.paymentLinkId),
    );

    const outcomes: Record<string, number> = {};
    let processed = 0;

    for (const link of openLinks) {
      if (ownedLinkIds.has(link.id)) {
        outcomes.skipped = (outcomes.skipped ?? 0) + 1;
        continue;
      }

      processed += 1;
      const result = await this.reconcilePaymentLink(link);
      outcomes[result] = (outcomes[result] ?? 0) + 1;
    }

    return { processed, outcomes };
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

      await this.syncPaymentLink(confirmed);

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

  /**
   * Mark a dashboard-only PaymentLink paid when Horizon matches.
   * Does not create Dev API Payment lifecycle events (no webhook until linked).
   */
  async reconcilePaymentLink(link: PaymentLink): Promise<ReconcileOutcome> {
    if (link.paidAt || link.paymentTxHash) return 'skipped';
    if (!link.amount) return 'skipped';
    if (!isClassicStellarAddress(link.destinationAddress)) return 'skipped';

    const environment = await this.resolveLinkEnvironment(link.id);
    const stellar = this.config.get<StellarConfig>('stellar')!;

    let records;
    try {
      records = await this.horizon.listPaymentsForAccount(
        link.destinationAddress,
        environment,
        stellar.reconcilerLookback,
      );
    } catch (err) {
      if (err instanceof CircuitOpenError) {
        this.logger.warn(
          { environment, linkId: link.id },
          'Horizon circuit open — skipping link reconcile',
        );
        return 'horizon_unavailable';
      }
      this.logger.error(
        {
          linkId: link.id,
          err: err instanceof Error ? err.message : String(err),
        },
        'Horizon query failed for PaymentLink',
      );
      return 'horizon_unavailable';
    }

    const knownHashes = await this.loadForeignHashes(
      records.map((r) => r.transactionHash),
      { excludeLinkId: link.id },
    );

    const result = this.verifier.verify(
      {
        linkMemo: link.linkMemo,
        destinationAddress: link.destinationAddress,
        amount: link.amount,
        currency: link.currency,
        environment,
        expiresAt: link.expiresAt,
      },
      records,
      knownHashes,
    );

    if (!result.ok) {
      if (result.code === 'duplicate_hash') {
        this.logger.error(
          { linkId: link.id, tx: result.payment?.transactionHash },
          'CRITICAL: duplicate tx hash on PaymentLink — skipping',
        );
        return 'skipped';
      }
      if (result.code === 'expired') return 'expired';
      return 'no_match';
    }

    // Re-read then write — avoid Prisma/Mongo `{ field: null }` missing-field traps
    const fresh = await this.prisma.paymentLink.findUnique({
      where: { id: link.id },
    });
    if (!fresh || fresh.paidAt || fresh.paymentTxHash) return 'skipped';

    await this.prisma.paymentLink.update({
      where: { id: link.id },
      data: {
        paymentTxHash: result.payment.transactionHash,
        paidAt: new Date(),
      },
    });

    this.logger.log(
      {
        linkId: link.id,
        memo: link.linkMemo,
        tx: result.payment.transactionHash,
      },
      'PaymentLink marked paid from Horizon match',
    );
    return 'link_paid';
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
      await this.syncPaymentLink(completed);
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

  private async syncPaymentLink(payment: Payment): Promise<void> {
    if (!payment.paymentLinkId || !payment.transactionHash) return;

    await this.prisma.paymentLink.update({
      where: { id: payment.paymentLinkId },
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

  /**
   * Horizon network for a dashboard link: use linked Payment.environment if any,
   * else test locally / live in production.
   */
  private async resolveLinkEnvironment(linkId: string): Promise<Environment> {
    const linked = await this.prisma.payment.findFirst({
      where: { paymentLinkId: linkId },
      select: { environment: true },
      orderBy: { createdAt: 'desc' },
    });
    if (linked) return linked.environment;

    const app = this.config.get<AppConfig>('app');
    return app?.nodeEnv === 'production' ? 'live' : 'test';
  }

  private async loadForeignHashes(
    hashes: string[],
    opts?: { excludePaymentId?: string; excludeLinkId?: string },
  ): Promise<Set<string>> {
    if (hashes.length === 0) return new Set();
    const unique = [...new Set(hashes)];

    const [paymentRows, linkRows] = await Promise.all([
      this.prisma.payment.findMany({
        where: {
          transactionHash: { in: unique },
          ...(opts?.excludePaymentId
            ? { NOT: { id: opts.excludePaymentId } }
            : {}),
        },
        select: { transactionHash: true },
      }),
      this.prisma.paymentLink.findMany({
        where: {
          paymentTxHash: { in: unique },
          ...(opts?.excludeLinkId ? { NOT: { id: opts.excludeLinkId } } : {}),
        },
        select: { paymentTxHash: true },
      }),
    ]);

    const out = new Set<string>();
    for (const r of paymentRows) {
      if (r.transactionHash) out.add(r.transactionHash);
    }
    for (const r of linkRows) {
      if (r.paymentTxHash) out.add(r.paymentTxHash);
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

function isClassicStellarAddress(address: string): boolean {
  return address.startsWith('G') && address.length === 56;
}
