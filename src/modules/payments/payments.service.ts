/**
 * PaymentsService — orchestrates the full payment creation flow (spec §11.3)
 * and delegates read/cancel operations.
 *
 * The 12-step POST /v1/payments flow:
 *  1.  ApiKeyGuard already resolved merchant context (done in guard)
 *  2.  Idempotency check — return cached response if key was seen before
 *  3.  DTO validated by controller (ValidationPipe)
 *  4.  Upsert customer by email
 *  5.  Generate IDs: pay_, evt_, hpl_ memo
 *  6.  Build linkMemo from payment publicId
 *  7.  Create Payment (status=created)
 *  8.  Emit payment.created event
 *  9.  Transition created→pending, emit payment.pending
 *  10. Store idempotency response
 *  11. Return 201 with payment
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import type { Payment } from '@prisma/client';

import { PrismaService } from '@/infrastructure/prisma/prisma.service';
import { IdempotencyService } from '@/modules/idempotency/idempotency.service';
import { CustomersRepository } from '@/modules/customers/customers.repository';
import { EventsService } from '@/modules/events/events.service';
import { PaymentStateMachine } from './payment-state-machine';
import { PaymentsRepository, decodeCursor } from './payments.repository';
import { ResourceNotFoundException } from '@/common/exceptions/hypertron.exception';
import { generateId, PREFIXES } from '@/common/utils/id-generator';
import { toPaymentResponse, type PaymentResponseDto } from './dto/payment-response.dto';
import type { CreatePaymentDto } from './dto/create-payment.dto';
import type { ListPaymentsDto } from './dto/list-payments.dto';
import type { MerchantContext } from '@/common/decorators/current-merchant.decorator';
import type { AppConfig } from '@/common/config/app.config';
import type { Environment } from '@prisma/client';

export interface CreatePaymentResult {
  payment: PaymentResponseDto;
  fromCache: boolean;
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: PaymentsRepository,
    private readonly idempotency: IdempotencyService,
    private readonly customers: CustomersRepository,
    private readonly events: EventsService,
    private readonly stateMachine: PaymentStateMachine,
    private readonly config: ConfigService,
  ) {}

  // ─── POST /v1/payments ──────────────────────────────────────────────────────

  async create(
    dto: CreatePaymentDto,
    merchant: MerchantContext,
    idempotencyKey: string,
  ): Promise<CreatePaymentResult> {
    // Step 2: idempotency check
    const requestHash = this.idempotency.hashBody(dto as unknown as Record<string, unknown>);
    const cached = await this.idempotency.check({
      businessId: merchant.businessId,
      apiKeyId: merchant.apiKeyId,
      key: idempotencyKey,
      requestHash,
    });

    if (cached.found) {
      return { payment: cached.cachedResponse as PaymentResponseDto, fromCache: true };
    }

    // Reserve the idempotency key before doing any writes
    await this.idempotency.reserve({
      businessId: merchant.businessId,
      apiKeyId: merchant.apiKeyId,
      key: idempotencyKey,
      requestHash,
    });

    // Steps 4–10: execute inside a try/catch to clean up reservation on failure
    try {
      // Step 4: upsert customer
      const customer = await this.customers.upsertByEmail({
        businessId: merchant.businessId,
        email: dto.customer_email,
        name: dto.customer_name,
      });

      // Step 5–6: generate IDs and linkMemo
      const paymentPublicId = generateId(PREFIXES.PAYMENT);
      const linkMemo = this.buildLinkMemo(paymentPublicId);

      const appConfig = this.config.get<AppConfig>('app')!;
      const checkoutUrl = `${appConfig.checkoutBaseUrl}/pay/${paymentPublicId}`;

      // Step 7: create Payment record (status=created)
      const payment = await this.repo.create({
        publicId: paymentPublicId,
        businessId: merchant.businessId,
        environment: merchant.environment as Environment,
        amount: dto.amount,
        currency: dto.currency,
        description: dto.description,
        customerId: customer.id,
        metadata: dto.metadata,
        checkoutUrl,
        paymentLinkId: paymentPublicId, // PaymentLink uses same ID for now
        linkMemo,
        destinationAddress: this.getDestinationAddress(merchant.environment),
        expiresAt: new Date(Date.now() + 30 * 60 * 1000), // 30 min default
      });

      // Step 8: emit payment.created
      await this.events.emit(payment, 'payment.created');

      // Step 9: created → pending
      const pendingPayment = await this.stateMachine.toPending(payment.id);

      // Build response DTO
      const responseDto = toPaymentResponse(pendingPayment);

      // Step 10: store idempotency response
      await this.idempotency.complete({
        businessId: merchant.businessId,
        apiKeyId: merchant.apiKeyId,
        key: idempotencyKey,
        responseStatus: 201,
        responseBody: responseDto,
      });

      this.logger.log(
        { paymentId: paymentPublicId, businessId: merchant.businessId },
        'Payment created successfully',
      );

      return { payment: responseDto, fromCache: false };
    } catch (err) {
      // Clean up the in-flight idempotency record so clients can retry
      await this.idempotency.complete({
        businessId: merchant.businessId,
        apiKeyId: merchant.apiKeyId,
        key: idempotencyKey,
        responseStatus: 0, // marks it failed so next check throws correctly
        responseBody: {},
      }).catch(() => {}); // best-effort
      throw err;
    }
  }

  // ─── GET /v1/payments/:id ───────────────────────────────────────────────────

  async findOne(id: string, merchant: MerchantContext): Promise<PaymentResponseDto> {
    const payment = await this.repo.findByPublicId(
      id,
      merchant.businessId,
      merchant.environment as Environment,
    );

    if (!payment) {
      throw new ResourceNotFoundException('payment', id);
    }

    return toPaymentResponse(payment);
  }

  // ─── GET /v1/payments ───────────────────────────────────────────────────────

  async findAll(
    query: ListPaymentsDto,
    merchant: MerchantContext,
  ) {
    const limit = query.limit ?? 25;
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;

    return this.repo.findAll({
      businessId: merchant.businessId,
      environment: merchant.environment as Environment,
      limit,
      cursor,
    });
  }

  // ─── POST /v1/payments/:id/cancel ──────────────────────────────────────────

  async cancel(id: string, merchant: MerchantContext): Promise<PaymentResponseDto> {
    const payment = await this.repo.findByPublicId(
      id,
      merchant.businessId,
      merchant.environment as Environment,
    );

    if (!payment) {
      throw new ResourceNotFoundException('payment', id);
    }

    const canceled = await this.stateMachine.toCanceled(payment.id);
    return toPaymentResponse(canceled);
  }

  // ─── GET /v1/payments/:id/events ───────────────────────────────────────────

  async findEvents(id: string, merchant: MerchantContext) {
    // Verify payment exists and belongs to this merchant
    const payment = await this.repo.findByPublicId(
      id,
      merchant.businessId,
      merchant.environment as Environment,
    );

    if (!payment) {
      throw new ResourceNotFoundException('payment', id);
    }

    return this.events.findByPayment(id, merchant.businessId);
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Builds a unique Stellar memo string from the payment public ID.
   * Format: hpl_<8-char base58 prefix of sha256(paymentPublicId)>
   * Fits within Stellar's 28-byte memo text limit.
   */
  private buildLinkMemo(paymentPublicId: string): string {
    const hash = crypto
      .createHash('sha256')
      .update(paymentPublicId)
      .digest('base64url')
      .slice(0, 8);
    return `hpl_${hash}`;
  }

  /**
   * Returns the Stellar destination address for the given environment.
   * In Phase 4 this is a placeholder — Phase 6 will wire the real keypairs.
   */
  private getDestinationAddress(environment: string): string {
    if (environment === 'live') {
      return (
        this.config.get<string>('STELLAR_MAINNET_DESTINATION_ADDRESS') ??
        'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZFOZ3GJJKM9MST9LNKLY' // testnet placeholder
      );
    }
    return (
      this.config.get<string>('STELLAR_TESTNET_DESTINATION_ADDRESS') ??
      'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZFOZ3GJJKM9MST9LNKLY'
    );
  }
}
