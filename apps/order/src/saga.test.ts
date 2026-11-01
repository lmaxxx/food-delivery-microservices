import { describe, expect, it } from 'vitest';
import { OrderStatus } from '@food/contracts';
import { SagaEvent, transition } from './saga';

function run(events: SagaEvent[], start: OrderStatus = 'PENDING_PAYMENT') {
  return events.reduce((status, event) => transition(status, event)?.next ?? status, start);
}

describe('order saga', () => {
  it('reaches DELIVERED on the happy path', () => {
    expect(
      run(['payment.done', 'order.accepted', 'courier.assigned', 'delivery.picked_up', 'delivery.completed']),
    ).toBe('DELIVERED');
  });

  it('cancels with no refund when payment fails', () => {
    const step = transition('PENDING_PAYMENT', 'payment.failed');
    expect(step).toEqual({ next: 'CANCELLED' });
  });

  it.each<[OrderStatus, SagaEvent]>([
    ['PAID', 'order.rejected'],
    ['ACCEPTED', 'courier.unavailable'],
    ['PENDING_PAYMENT', 'timeout'],
    ['PAID', 'timeout'],
    ['ACCEPTED', 'timeout'],
  ])('compensates with a refund from %s on %s', (status, event) => {
    expect(transition(status, event)).toEqual({ next: 'REFUNDING', emit: 'payment.refund_requested' });
  });

  it('only cancels after the refund is confirmed', () => {
    expect(transition('REFUNDING', 'payment.refunded')?.next).toBe('CANCELLED');
    expect(transition('REFUNDING', 'order.accepted')).toBeNull();
  });

  it('tolerates courier.assigned arriving before order.accepted', () => {
    expect(run(['payment.done', 'courier.assigned', 'order.accepted'])).toBe('COURIER_ASSIGNED');
  });

  it('ignores a late payment.done after a timeout refund', () => {
    expect(run(['timeout', 'payment.done'])).toBe('REFUNDING');
  });

  it.each<OrderStatus>(['DELIVERED', 'CANCELLED'])('treats %s as terminal', (status) => {
    for (const event of ['payment.done', 'order.accepted', 'timeout', 'delivery.completed'] as SagaEvent[]) {
      expect(transition(status, event)).toBeNull();
    }
  });

  it('does not time out once a courier has the order', () => {
    expect(transition('COURIER_ASSIGNED', 'timeout')).toBeNull();
    expect(transition('PICKED_UP', 'timeout')).toBeNull();
  });
});
