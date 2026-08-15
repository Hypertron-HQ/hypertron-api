/**
 * Unit tests — EventsService → webhook dispatch seam (Plan §13.1)
 *
 * The event store is authoritative: emitting must succeed (and return the
 * stored event) even when webhook enqueueing is unavailable or throws.
 */

import { Test } from '@nestjs/testing';
import type { Payment, PaymentEvent } from '@prisma/client';

import { EventsService } from '@/modules/events/events.service';
import { PrismaService } from '@/infrastructure/prisma/prisma.service';
import {
  WEBHOOK_DISPATCHER,
  type WebhookDispatcher,
} from '@/modules/webhooks/webhook-dispatcher';

const payment = {
  id: 'oid_1',
  publicId: 'pay_01JABC123',
  businessId: 'biz_1',
  environment: 'test',
  status: 'completed',
} as unknown as Payment;

function prismaMock() {
  return {
    paymentEvent: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'evt_internal_1',
        createdAt: new Date(),
        ...data,
      })) as unknown as jest.Mock,
    },
  };
}

async function buildService(dispatcher?: WebhookDispatcher) {
  const prisma = prismaMock();

  const moduleRef = await Test.createTestingModule({
    providers: [
      EventsService,
      { provide: PrismaService, useValue: prisma },
      ...(dispatcher
        ? [{ provide: WEBHOOK_DISPATCHER, useValue: dispatcher }]
        : []),
    ],
  }).compile();

  return { service: moduleRef.get(EventsService), prisma };
}

describe('EventsService webhook dispatch', () => {
  it('dispatches the stored event to the webhook queue', async () => {
    const dispatchEvent = jest.fn().mockResolvedValue(undefined);
    const { service } = await buildService({ dispatchEvent });

    const event = await service.emit(payment, 'payment.completed');

    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    const [dispatched] = dispatchEvent.mock.calls[0] as [PaymentEvent];
    expect(dispatched.publicId).toBe(event.publicId);
    expect(dispatched.type).toBe('payment.completed');
  });

  it('stores the event before dispatching', async () => {
    const dispatchEvent = jest.fn().mockResolvedValue(undefined);
    const { service, prisma } = await buildService({ dispatchEvent });

    await service.emit(payment, 'payment.pending');

    expect(prisma.paymentEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.paymentEvent.create.mock.invocationCallOrder[0]).toBeLessThan(
      dispatchEvent.mock.invocationCallOrder[0],
    );
  });

  it('still returns the event when dispatching fails', async () => {
    const dispatchEvent = jest.fn().mockRejectedValue(new Error('redis down'));
    const { service } = await buildService({ dispatchEvent });

    const event = await service.emit(payment, 'payment.completed');

    expect(event.publicId).toMatch(/^evt_/);
  });

  it('works when no dispatcher is bound', async () => {
    const { service } = await buildService();

    await expect(
      service.emit(payment, 'payment.created'),
    ).resolves.toMatchObject({
      type: 'payment.created',
    });
  });
});
