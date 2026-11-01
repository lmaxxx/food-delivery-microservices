import { EventType, OrderStatus } from '@food/contracts';

/**
 * The saga as a pure state machine: no I/O, so every path is easy to test.
 * Order Service is the orchestrator: it alone decides what an order's next step is.
 */
export interface Transition {
  next: OrderStatus;
  /** A follow-up event that drives the next saga step or a compensation. */
  emit?: 'order.paid' | 'payment.refund_requested';
  /** How long to wait for the next step before compensating. */
  deadline?: 'payment' | 'restaurant' | 'courier';
}

const REFUND: Transition = { next: 'REFUNDING', emit: 'payment.refund_requested' };

type SagaEvent =
  | 'payment.done'
  | 'payment.failed'
  | 'payment.refunded'
  | 'order.accepted'
  | 'order.rejected'
  | 'courier.assigned'
  | 'courier.unavailable'
  | 'delivery.picked_up'
  | 'delivery.completed'
  | 'timeout';

/**
 * Some "forward jumps" are deliberate. Kafka only orders messages within one
 * partition, and each event type has its own topic, so courier.assigned can be
 * consumed before order.accepted. A late event finds no entry and is ignored.
 */
const TABLE: Partial<Record<OrderStatus, Partial<Record<SagaEvent, Transition>>>> = {
  PENDING_PAYMENT: {
    'payment.done': { next: 'PAID', emit: 'order.paid', deadline: 'restaurant' },
    'payment.failed': { next: 'CANCELLED' },
    // Payment may have charged without us hearing about it, so a timeout must refund.
    timeout: REFUND,
  },
  PAID: {
    'order.accepted': { next: 'ACCEPTED', deadline: 'courier' },
    'order.rejected': REFUND,
    'courier.assigned': { next: 'COURIER_ASSIGNED' },
    'courier.unavailable': REFUND,
    timeout: REFUND,
  },
  ACCEPTED: {
    'courier.assigned': { next: 'COURIER_ASSIGNED' },
    'courier.unavailable': REFUND,
    'delivery.picked_up': { next: 'PICKED_UP' },
    timeout: REFUND,
  },
  COURIER_ASSIGNED: {
    'delivery.picked_up': { next: 'PICKED_UP' },
    'delivery.completed': { next: 'DELIVERED' },
  },
  PICKED_UP: {
    'delivery.completed': { next: 'DELIVERED' },
  },
  REFUNDING: {
    'payment.refunded': { next: 'CANCELLED' },
  },
};

/** Returns null when the event does not apply in this state. */
export function transition(status: OrderStatus, event: SagaEvent): Transition | null {
  return TABLE[status]?.[event] ?? null;
}

export type { SagaEvent };
export const SAGA_EVENTS: Exclude<SagaEvent, 'timeout'>[] = [
  'payment.done',
  'payment.failed',
  'payment.refunded',
  'order.accepted',
  'order.rejected',
  'courier.assigned',
  'courier.unavailable',
  'delivery.picked_up',
  'delivery.completed',
];

// Compile-time check that saga events exist in the event catalogue.
const _check: EventType[] = SAGA_EVENTS;
void _check;
