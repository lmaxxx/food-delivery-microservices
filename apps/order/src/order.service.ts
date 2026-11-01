import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import {
  databaseUrl,
  EventEnvelope,
  EventPayload,
  EventType,
  makeEvent,
  OrderStatus,
} from '@food/contracts';
import { EventBus, Handlers } from '@food/kafka';
import { createLogger, currentCorrelationId, runWithCorrelation } from '@food/observability';
import { Prisma, PrismaClient } from './generated/prisma';
import { SAGA_EVENTS, SagaEvent, transition, Transition } from './saga';

const log = createLogger('order');

type OrderRow = Prisma.OrderGetPayload<{ include: { history: true } }>;
type Tx = Prisma.TransactionClient;
type StoredItem = { menuItemId: string; name: string; quantity: number; priceCents: number };

const DEADLINE_MS = {
  payment: Number(process.env.SAGA_PAYMENT_TIMEOUT_MS ?? 60_000),
  restaurant: Number(process.env.SAGA_RESTAURANT_TIMEOUT_MS ?? 300_000),
  courier: Number(process.env.SAGA_COURIER_TIMEOUT_MS ?? 60_000),
};

export interface CreateOrderInput {
  customerId: string;
  customerEmail: string;
  idempotencyKey: string;
  restaurantId: string;
  items: { menuItemId: string; quantity: number }[];
  deliveryAddress: string;
  deliveryLat: number;
  deliveryLng: number;
  cardWillFail: boolean;
}

@Injectable()
export class OrderService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly prisma = new PrismaClient({ datasourceUrl: databaseUrl('orders') });
  // Consumer only. This service never publishes directly: everything goes through the outbox.
  private readonly bus = new EventBus('order');
  private timer?: NodeJS.Timeout;

  async onApplicationBootstrap() {
    const handlers: Handlers = {
      'restaurant.updated': (event) => this.onRestaurantUpdated(event),
      'order.ready': (event) => this.onOrderReady(event),
    };
    for (const type of SAGA_EVENTS) {
      (handlers as Record<string, unknown>)[type] = (event: EventEnvelope) =>
        this.applySagaEvent(event, type);
    }
    await this.bus.connect();
    await this.bus.subscribe('order', handlers);
    this.timer = setInterval(() => void this.sweep(), 5_000);
  }

  async onModuleDestroy() {
    clearInterval(this.timer);
    await this.bus.disconnect();
  }

  // ---------- Commands (gRPC) ----------

  async create(input: CreateOrderInput) {
    const existing = await this.findByKey(input.customerId, input.idempotencyKey);
    if (existing) return existing;

    const items = await this.priceItems(input);
    const totalCents = items.reduce((sum, item) => sum + item.priceCents * item.quantity, 0);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const order = await tx.order.create({
          data: {
            customerId: input.customerId,
            customerEmail: input.customerEmail,
            idempotencyKey: input.idempotencyKey,
            restaurantId: input.restaurantId,
            status: 'PENDING_PAYMENT',
            totalCents,
            items,
            deliveryAddress: input.deliveryAddress,
            deliveryLat: input.deliveryLat,
            deliveryLng: input.deliveryLng,
            correlationId: currentCorrelationId(),
            deadlineAt: new Date(Date.now() + DEADLINE_MS.payment),
            history: { create: { status: 'PENDING_PAYMENT' } },
          },
          include: { history: true },
        });
        // The heart of the outbox pattern: state and event commit together, or not at all.
        await this.enqueue(tx, 'order.created', order.id, {
          ...this.details(order),
          cardWillFail: input.cardWillFail,
        });
        await this.enqueueStatus(tx, order, null);
        return order;
      });
    } catch (error) {
      // A concurrent request with the same key won the race on the unique index.
      if ((error as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
        const winner = await this.findByKey(input.customerId, input.idempotencyKey);
        if (winner) return winner;
      }
      throw error;
    }
  }

  async get(orderId: string, requesterId: string, requesterRole: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { history: { orderBy: { id: 'asc' } } },
    });
    if (!order) throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'Order not found' });
    const allowed =
      (requesterRole === 'CUSTOMER' && order.customerId === requesterId) ||
      (requesterRole === 'COURIER' && order.courierId === requesterId);
    if (!allowed) throw new RpcException({ code: GrpcStatus.PERMISSION_DENIED, message: 'Not your order' });
    return order;
  }

  list(customerId: string) {
    return this.prisma.order.findMany({
      where: { customerId },
      include: { history: { orderBy: { id: 'asc' } } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  private findByKey(customerId: string, idempotencyKey: string) {
    return this.prisma.order.findUnique({
      where: { customerId_idempotencyKey: { customerId, idempotencyKey } },
      include: { history: { orderBy: { id: 'asc' } } },
    });
  }

  /** Prices come from our local snapshot, never from the client and with no sync call. */
  private async priceItems(input: CreateOrderInput): Promise<StoredItem[]> {
    if (input.items.length === 0) {
      throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: 'Order has no items' });
    }
    const snapshots = await this.prisma.menuItemSnapshot.findMany({
      where: { id: { in: input.items.map((i) => i.menuItemId) }, restaurantId: input.restaurantId },
    });
    return input.items.map((item) => {
      const snapshot = snapshots.find((s) => s.id === item.menuItemId);
      if (!snapshot || item.quantity < 1) {
        throw new RpcException({
          code: GrpcStatus.INVALID_ARGUMENT,
          message: `Invalid item ${item.menuItemId}`,
        });
      }
      return {
        menuItemId: item.menuItemId,
        name: snapshot.name,
        quantity: item.quantity,
        priceCents: snapshot.priceCents,
      };
    });
  }

  // ---------- Saga (Kafka) ----------

  private async applySagaEvent(event: EventEnvelope, type: SagaEvent) {
    const orderId = (event.payload as { orderId: string }).orderId;
    const courierId = (event.payload as { courierId?: string }).courierId;
    const reason = (event.payload as { reason?: string }).reason ?? null;

    await this.prisma.$transaction(async (tx) => {
      if (!(await this.claim(tx, event.eventId))) return;
      const order = await this.lock(tx, orderId);
      if (!order) throw new Error(`Unknown order ${orderId}`);
      const step = transition(order.status as OrderStatus, type);
      if (!step) {
        log.warn({ orderId, status: order.status, type }, 'event ignored in this state');
        return;
      }
      await this.advance(tx, order, step, reason, courierId);
    });
  }

  private async onOrderReady(event: EventEnvelope<'order.ready'>) {
    await this.prisma.$transaction(async (tx) => {
      if (!(await this.claim(tx, event.eventId))) return;
      const order = await this.lock(tx, event.payload.orderId);
      if (!order) throw new Error(`Unknown order ${event.payload.orderId}`);
      // Readiness runs in parallel with courier search, so it is a flag, not a status.
      const updated = await tx.order.update({
        where: { id: order.id },
        data: { ready: true, history: { create: { status: 'READY' } } },
      });
      await this.enqueueStatus(tx, updated, 'Food is ready');
    });
  }

  private async onRestaurantUpdated(event: EventEnvelope<'restaurant.updated'>) {
    for (const item of event.payload.menu) {
      const data = {
        restaurantId: event.payload.restaurantId,
        name: item.name,
        priceCents: item.priceCents,
      };
      await this.prisma.menuItemSnapshot.upsert({
        where: { id: item.id },
        create: { id: item.id, ...data },
        update: data,
      });
    }
  }

  /** Dedup row and business change share a transaction, so they cannot drift apart. */
  private async claim(tx: Tx, eventId: string) {
    const { count } = await tx.processedEvent.createMany({ data: [{ eventId }], skipDuplicates: true });
    return count === 1;
  }

  /** Row lock: serializes this saga step against other consumers and the timeout sweep. */
  private async lock(tx: Tx, orderId: string) {
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
    return tx.order.findUnique({ where: { id: orderId }, include: { history: true } });
  }

  private async advance(
    tx: Tx,
    order: OrderRow,
    step: Transition,
    reason: string | null,
    courierId?: string,
  ) {
    const updated = await tx.order.update({
      where: { id: order.id },
      data: {
        status: step.next,
        courierId: courierId ?? order.courierId,
        deadlineAt: step.deadline ? new Date(Date.now() + DEADLINE_MS[step.deadline]) : null,
        history: { create: { status: step.next, reason } },
      },
      include: { history: true },
    });
    if (step.emit === 'order.paid') {
      await this.enqueue(tx, 'order.paid', order.id, this.details(updated));
    }
    if (step.emit === 'payment.refund_requested') {
      await this.enqueue(tx, 'payment.refund_requested', order.id, {
        orderId: order.id,
        reason: reason ?? 'Saga compensation',
      });
    }
    await this.enqueueStatus(tx, updated, reason);
  }

  /** Compensates sagas stuck past their deadline, including those lost to a dual-write crash. */
  private async sweep() {
    try {
      const expired = await this.prisma.order.findMany({
        where: { deadlineAt: { lt: new Date() } },
        select: { id: true, correlationId: true },
        take: 100,
      });
      for (const { id, correlationId } of expired) {
        await runWithCorrelation(correlationId, () =>
          this.prisma.$transaction(async (tx) => {
            const order = await this.lock(tx, id);
            // Re-check under the lock: an event may have advanced it since the query.
            if (!order?.deadlineAt || order.deadlineAt > new Date()) return;
            const step = transition(order.status as OrderStatus, 'timeout');
            if (!step) return;
            log.warn({ orderId: id, status: order.status }, 'saga deadline passed, compensating');
            await this.advance(tx, order, step, `Timed out in ${order.status}`);
          }),
        );
      }
      // Debezium has read inserted rows from the WAL. Old rows are only taking up space.
      await this.prisma.outbox.deleteMany({
        where: { createdAt: { lt: new Date(Date.now() - 3_600_000) } },
      });
    } catch (error) {
      log.error({ err: error }, 'saga sweep failed');
    }
  }

  // ---------- Outbox ----------

  private async enqueue<T extends EventType>(tx: Tx, type: T, aggregateId: string, payload: EventPayload<T>) {
    const event = makeEvent(type, payload, currentCorrelationId());
    await tx.outbox.create({
      data: {
        id: event.eventId,
        aggregatetype: 'order',
        aggregateid: aggregateId,
        type,
        payload: JSON.stringify(event),
      },
    });
  }

  private enqueueStatus(
    tx: Tx,
    order: {
      id: string;
      customerId: string;
      customerEmail: string;
      restaurantId: string;
      courierId: string | null;
      status: string;
    },
    reason: string | null,
  ) {
    return this.enqueue(tx, 'order.status_changed', order.id, {
      orderId: order.id,
      customerId: order.customerId,
      customerEmail: order.customerEmail,
      restaurantId: order.restaurantId,
      courierId: order.courierId,
      status: order.status as OrderStatus,
      reason,
    });
  }

  private details(order: OrderRow) {
    return {
      orderId: order.id,
      customerId: order.customerId,
      restaurantId: order.restaurantId,
      items: order.items as StoredItem[],
      totalCents: order.totalCents,
      delivery: { address: order.deliveryAddress, lat: order.deliveryLat, lng: order.deliveryLng },
    };
  }
}
