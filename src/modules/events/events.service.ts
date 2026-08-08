/**
 * EventsService — append-only immutable payment event store.
 *
 * Spec section 5 / Plan module responsibility rules:
 *  - EventsModule owns append-only event store
 *  - Must NOT modify other resource rows
 *  - Each event stores an immutable snapshot of the payment at that moment
 */

import { Injectable, Logger } from '@nestjs/common';
import type { Payment, PaymentEvent } from '@prisma/client';
import { PrismaService } from '@/infrastructure/prisma/prisma.service';
import { generateId, PREFIXES } from '@/common/utils/id-generator';

@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Appends an immutable event to the payment event log.
   *
   * @param payment   The current payment state (snapshot stored in `data`)
   * @param eventType e.g. 'payment.created', 'payment.pending', 'payment.completed'
   */
  async emit(payment: Payment, eventType: string): Promise<PaymentEvent> {
    const publicId = generateId(PREFIXES.EVENT);

    // The snapshot is the full payment object at the moment of emission.
    // Cast to object for Prisma Json field — we exclude internal Prisma id.
    const snapshot = { ...payment } as unknown as object;

    const event = await this.prisma.paymentEvent.create({
      data: {
        publicId,
        businessId: payment.businessId,
        paymentId: payment.id,
        type: eventType,
        data: snapshot,
      },
    });

    this.logger.log(
      { eventType, paymentId: payment.publicId, eventId: publicId },
      'Payment event emitted',
    );

    return event;
  }

  /**
   * Returns all events for a payment, scoped to the business.
   * Returns [] if the payment doesn't belong to this business (404 handled by caller).
   */
  async findByPayment(
    paymentPublicId: string,
    businessId: string,
  ): Promise<PaymentEvent[]> {
    // First resolve the payment's internal id via publicId + businessId
    const payment = await this.prisma.payment.findFirst({
      where: { publicId: paymentPublicId, businessId },
      select: { id: true },
    });

    if (!payment) return [];

    return this.prisma.paymentEvent.findMany({
      where: { paymentId: payment.id, businessId },
      orderBy: { createdAt: 'asc' },
    });
  }
}
