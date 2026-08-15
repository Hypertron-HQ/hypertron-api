/**
 * PaymentsService — orchestrates the full payment creation flow (spec §11.3)
 * and delegates read/cancel operations.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { PrismaService } from '@/infrastructure/prisma/prisma.service';
import { IdempotencyService } from '@/modules/idempotency/idempotency.service';
import { CustomersRepository } from '@/modules/customers/customers.repository';
import { EventsService } from '@/modules/events/events.service';
import { MetricsService } from '@/observability/metrics.service';
import { PaymentStateMachine } from './payment-state-machine';
import { PaymentsRepository, decodeCursor } from './payments.repository';
import { ResourceNotFoundException } from '@/common/exceptions/hypertron.exception';
import { generateId, PREFIXES } from '@/common/utils/id-generator';
import {
  toPaymentResponse,
  type PaymentResponseDto,
} from './dto/payment-response.dto';
import type { CreatePaymentDto } from './dto/create-payment.dto';
import type { ListPaymentsDto } from './dto/list-payments.dto';
import type { MerchantContext } from '@/common/decorators/current-merchant.decorator';
import type { AppConfig } from '@/common/config/app.config';
import type { StellarConfig } from '@/common/config/stellar.config';
import { InvalidRequestException } from '@/common/exceptions/hypertron.exception';

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
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  // ─── POST /v1/payments ──────────────────────────────────────────────────────

  async create(
    dto: CreatePaymentDto,
    merchant: MerchantContext,
    idempotencyKey: string,
  ): Promise<CreatePaymentResult> {
    const requestHash = this.idempotency.hashBody(
      dto as unknown as Record<string, unknown>,
    );
    const cached = await this.idempotency.check({
      businessId: merchant.businessId,
      apiKeyId: merchant.apiKeyId,
      key: idempotencyKey,
      requestHash,
    });

    if (cached.found) {
      return {
        payment: cached.cachedResponse as PaymentResponseDto,
        fromCache: true,
      };
    }

    await this.idempotency.reserve({
      businessId: merchant.businessId,
      apiKeyId: merchant.apiKeyId,
      key: idempotencyKey,
      requestHash,
    });

    try {
      const customer = await this.customers.upsertByEmail({
        businessId: merchant.businessId,
        email: dto.customer_email,
        name: dto.customer_name,
      });

      const paymentPublicId = generateId(PREFIXES.PAYMENT);
      const checkoutPublicId = generateId(PREFIXES.CHECKOUT_LINK);
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
      const destinationAddress = await this.resolveDestinationAddress(
        merchant.businessId,
        merchant.environment,
      );
      if (!destinationAddress) {
        throw new InvalidRequestException(
          'payment_destination_unconfigured',
          'No classic payment destination configured. Set receiveAddress on the merchant (or STELLAR_*_DESTINATION).',
        );
      }

      const linkMemo = await this.createUniqueLinkMemo();

      // LOAD-BEARING: CheckoutLink has no metadata / shield fields by design.
      // dto.metadata goes onto the Payment record only — never the checkout link.
      // Private settlement is dashboard-only (core PaymentLink + shieldSalt/Commitment/Proof).
      // If someone later "improves" this to pass dto.metadata (or a privateSettlement
      // flag) onto the link, API-created checkouts become reachable as "private"
      // without shield data — producing exactly the broken payments we're fixing.
      const checkoutLink = await this.prisma.checkoutLink.create({
        data: {
          publicId: checkoutPublicId,
          businessId: merchant.businessId,
          environment: merchant.environment,
          amount: dto.amount,
          currency: dto.currency,
          description: dto.description ?? null,
          linkMemo,
          destinationAddress,
          expiresAt,
        },
      });

      const appConfig = this.config.get<AppConfig>('app')!;
      const checkoutUrl = `${appConfig.checkoutBaseUrl}/pay/${checkoutLink.publicId}`;

      const payment = await this.repo.create({
        publicId: paymentPublicId,
        businessId: merchant.businessId,
        environment: merchant.environment,
        amount: dto.amount,
        currency: dto.currency,
        description: dto.description,
        customerId: customer.id,
        metadata: dto.metadata,
        checkoutUrl,
        checkoutLinkId: checkoutLink.id,
        linkMemo,
        destinationAddress,
        expiresAt,
      });

      await this.events.emit(payment, 'payment.created');
      const pendingPayment = await this.stateMachine.toPending(payment.id);
      const responseDto = toPaymentResponse(pendingPayment);

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

      this.metrics?.recordPaymentCreated(
        merchant.environment,
        dto.currency,
      );

      return { payment: responseDto, fromCache: false };
    } catch (err) {
      await this.idempotency
        .complete({
          businessId: merchant.businessId,
          apiKeyId: merchant.apiKeyId,
          key: idempotencyKey,
          responseStatus: 0,
          responseBody: {},
        })
        .catch(() => {});
      throw err;
    }
  }

  async findOne(
    id: string,
    merchant: MerchantContext,
  ): Promise<PaymentResponseDto> {
    const payment = await this.repo.findByPublicId(
      id,
      merchant.businessId,
      merchant.environment,
    );

    if (!payment) {
      throw new ResourceNotFoundException('payment', id);
    }

    return toPaymentResponse(payment);
  }

  async findAll(query: ListPaymentsDto, merchant: MerchantContext) {
    const limit = query.limit ?? 25;
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;

    return this.repo.findAll({
      businessId: merchant.businessId,
      environment: merchant.environment,
      limit,
      cursor,
    });
  }

  async cancel(
    id: string,
    merchant: MerchantContext,
  ): Promise<PaymentResponseDto> {
    const payment = await this.repo.findByPublicId(
      id,
      merchant.businessId,
      merchant.environment,
    );

    if (!payment) {
      throw new ResourceNotFoundException('payment', id);
    }

    const canceled = await this.stateMachine.toCanceled(payment.id);
    return toPaymentResponse(canceled);
  }

  async findEvents(id: string, merchant: MerchantContext) {
    const payment = await this.repo.findByPublicId(
      id,
      merchant.businessId,
      merchant.environment,
    );

    if (!payment) {
      throw new ResourceNotFoundException('payment', id);
    }

    return this.events.findByPayment(id, merchant.businessId);
  }

  /**
   * Classic checkout destination: merchant G… only (never pool C…).
   * Prefer MerchantSettings.receiveAddress → env STELLAR_*_DESTINATION.
   */
  private async resolveDestinationAddress(
    businessId: string,
    environment: string,
  ): Promise<string> {
    const settings = await this.prisma.merchantSettings.findUnique({
      where: { businessId },
      select: { receiveAddress: true },
    });
    const stellar = this.config.get<StellarConfig>('stellar');
    const envDestination =
      environment === 'live'
        ? stellar?.mainnetDestinationAddress
        : stellar?.testnetDestinationAddress;

    const candidates = [
      settings?.receiveAddress?.trim(),
      envDestination?.trim(),
    ];

    for (const addr of candidates) {
      if (addr && isClassicStellarAddress(addr)) return addr;
    }
    return '';
  }

  private async createUniqueLinkMemo(): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const memo = `hpl_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
      const existing = await this.prisma.checkoutLink.findUnique({
        where: { linkMemo: memo },
        select: { id: true },
      });
      if (!existing) return memo;
    }
    throw new InvalidRequestException(
      'memo_generation_failed',
      'Could not allocate a unique payment memo. Retry the request.',
    );
  }
}

/** Classic Stellar account public key (G…, 56 chars) — never contract C…. */
function isClassicStellarAddress(address: string): boolean {
  return address.startsWith('G') && address.length === 56;
}
