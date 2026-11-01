import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/**
 * The event catalogue: the public API between services.
 * Each event type has its own Kafka topic with the same name.
 */
const orderId = z.string().uuid();
const point = { lat: z.number(), lng: z.number() };

const orderItem = z.object({
  menuItemId: z.string(),
  name: z.string(),
  quantity: z.number().int().positive(),
  priceCents: z.number().int().nonnegative(),
});

const courierRef = z.object({ orderId, courierId: z.string(), customerId: z.string() });

export const OrderStatus = z.enum([
  'PENDING_PAYMENT',
  'PAID',
  'ACCEPTED',
  'COURIER_ASSIGNED',
  'PICKED_UP',
  'DELIVERED',
  'REFUNDING',
  'CANCELLED',
]);
export type OrderStatus = z.infer<typeof OrderStatus>;

const orderDetails = z.object({
  orderId,
  customerId: z.string(),
  restaurantId: z.string(),
  items: z.array(orderItem),
  totalCents: z.number().int().nonnegative(),
  delivery: z.object({ address: z.string(), ...point }),
});

export const EventSchemas = {
  // Published by Order Service, through the outbox and Debezium
  'order.created': orderDetails.extend({ cardWillFail: z.boolean() }),
  'order.paid': orderDetails,
  'payment.refund_requested': z.object({ orderId, reason: z.string() }),
  'order.status_changed': z.object({
    orderId,
    customerId: z.string(),
    customerEmail: z.string(),
    restaurantId: z.string(),
    courierId: z.string().nullable(),
    status: OrderStatus,
    reason: z.string().nullable(),
  }),

  // Published by Payment Service
  'payment.done': z.object({ orderId, paymentId: z.string(), amountCents: z.number().int() }),
  'payment.failed': z.object({ orderId, reason: z.string() }),
  'payment.refunded': z.object({ orderId, amountCents: z.number().int() }),

  // Published by Restaurant Service
  'order.accepted': z.object({
    orderId,
    customerId: z.string(),
    restaurantId: z.string(),
    pickup: z.object(point),
    delivery: z.object(point),
  }),
  'order.rejected': z.object({ orderId, restaurantId: z.string(), reason: z.string() }),
  'order.ready': z.object({ orderId, restaurantId: z.string() }),
  'restaurant.updated': z.object({
    restaurantId: z.string(),
    name: z.string(),
    cuisine: z.string(),
    lat: z.number(),
    lng: z.number(),
    menu: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        description: z.string(),
        priceCents: z.number().int(),
      }),
    ),
  }),

  // Published by Delivery Service
  'courier.assigned': courierRef.extend({ distanceKm: z.number() }),
  'courier.unavailable': z.object({ orderId, reason: z.string() }),
  'courier.location': courierRef.extend(point),
  'delivery.picked_up': courierRef,
  'delivery.completed': courierRef,
} as const;

export type EventType = keyof typeof EventSchemas;
export type EventPayload<T extends EventType> = z.infer<(typeof EventSchemas)[T]>;

export const ALL_EVENT_TYPES = Object.keys(EventSchemas) as EventType[];

/** Kept forever per key: the latest value for each key can rebuild a read model. */
export const COMPACTED_TOPICS: EventType[] = ['restaurant.updated'];

export const dlqTopic = (topic: string) => `${topic}.dlq`;

export interface EventEnvelope<T extends EventType = EventType> {
  /** Unique per event. Consumers use it to discard duplicates. */
  eventId: string;
  type: T;
  /** Schema version, so a consumer can handle old and new shapes during a rollout. */
  version: number;
  occurredAt: string;
  /** Follows one user action across HTTP, gRPC and Kafka. */
  correlationId: string;
  payload: EventPayload<T>;
}

const EnvelopeSchema = z.object({
  eventId: z.string().uuid(),
  type: z.string(),
  version: z.number().int(),
  occurredAt: z.string(),
  correlationId: z.string(),
  payload: z.unknown(),
});

export function makeEvent<T extends EventType>(
  type: T,
  payload: EventPayload<T>,
  correlationId: string,
): EventEnvelope<T> {
  return {
    eventId: randomUUID(),
    type,
    version: 1,
    occurredAt: new Date().toISOString(),
    correlationId,
    payload: EventSchemas[type].parse(payload) as EventPayload<T>,
  };
}

/** Throws when the message does not match the contract. */
export function parseEvent(raw: string, topic: string): EventEnvelope {
  const envelope = EnvelopeSchema.parse(JSON.parse(raw));
  if (envelope.type !== topic) {
    throw new Error(`Event type ${envelope.type} does not belong on topic ${topic}`);
  }
  const schema = EventSchemas[envelope.type as EventType];
  if (!schema) throw new Error(`Unknown event type ${envelope.type}`);
  return { ...envelope, payload: schema.parse(envelope.payload) } as EventEnvelope;
}
