/**
 * End-to-end checks against the running stack. Requires infra and `pnpm dev`.
 * Everything goes through the public gateways, apart from events injected into Kafka.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Kafka, logLevel, Partitioners } from 'kafkajs';
import { io } from 'socket.io-client';
import { config, DEMO, dlqTopic, makeEvent } from '@food/contracts';
import { api, http, login, placeOrder, Session, waitFor, waitForStatus } from './lib';

const kafka = new Kafka({ brokers: config.kafkaBrokers, logLevel: logLevel.ERROR });
const producer = kafka.producer({ createPartitioner: Partitioners.DefaultPartitioner });

let customer: Session;
let courier: Session;
let kitchen: Session;

const statuses = (order: { history: { status: string }[] }) => order.history.map((h) => h.status);
const accept = (orderId: string) =>
  api(`/kitchen/tickets/${orderId}/accept`, { method: 'POST', token: kitchen.token });
const courierOnline = () =>
  api('/courier/location', {
    method: 'POST',
    token: courier.token,
    body: JSON.stringify({ lat: 50.451, lng: 30.524 }),
  });
const courierOffline = () => api('/courier/offline', { method: 'POST', token: courier.token });

async function deliverOrder(orderId: string) {
  await waitForStatus(customer, orderId, 'PAID');
  await waitFor('kitchen ticket', async () => {
    const tickets = await api('/kitchen/tickets', { token: kitchen.token });
    return tickets.some((t: { orderId: string }) => t.orderId === orderId);
  });
  await accept(orderId);
  await waitForStatus(customer, orderId, 'COURIER_ASSIGNED');

  const early = await http('/courier/job/pickup', { method: 'POST', token: courier.token });
  assert.equal(early.status, 409, 'pickup before the food is ready must be refused');

  await api(`/kitchen/tickets/${orderId}/ready`, { method: 'POST', token: kitchen.token });
  await waitFor('pickup to succeed', async () => {
    const { status } = await http('/courier/job/pickup', { method: 'POST', token: courier.token });
    return status < 300;
  });
  await waitForStatus(customer, orderId, 'PICKED_UP');
  await api('/courier/job/deliver', { method: 'POST', token: courier.token });
  return waitForStatus(customer, orderId, 'DELIVERED');
}

const tests: [string, () => Promise<void>][] = [
  [
    'happy path reaches DELIVERED, with live status over WebSocket',
    async () => {
      await courierOnline();
      const seen: string[] = [];
      const socket = io(process.env.WS_URL ?? 'http://localhost:3010', {
        auth: { token: customer.token },
        transports: ['websocket'],
      });
      await new Promise<void>((resolve, reject) => {
        socket.on('connect', resolve);
        socket.on('connect_error', reject);
      });

      const created = await placeOrder(customer);
      assert.equal(created.status, 'PENDING_PAYMENT');
      assert.equal(created.totalCents, 2 * 1100 + 1250, 'server computes the total from its snapshot');
      socket.on('event', (event) => {
        if (event.type === 'order.status_changed' && event.payload.orderId === created.id) {
          assert.equal(event.payload.customerEmail, undefined, 'email must not reach the browser');
          seen.push(event.payload.status);
        }
      });

      const order = await deliverOrder(created.id);
      assert.deepEqual(statuses(order), [
        'PENDING_PAYMENT',
        'PAID',
        'ACCEPTED',
        'COURIER_ASSIGNED',
        'READY',
        'PICKED_UP',
        'DELIVERED',
      ]);
      assert.equal(order.courierId, DEMO.courier.id);
      await waitFor('the kitchen ticket to close', async () => {
        const tickets = await api('/kitchen/tickets', { token: kitchen.token });
        return !tickets.some((t: { orderId: string }) => t.orderId === created.id);
      });
      await waitFor('DELIVERED over WebSocket', async () => seen.includes('DELIVERED'));
      socket.close();
    },
  ],
  [
    'failed payment cancels the order',
    async () => {
      const { id } = await placeOrder(customer, { cardWillFail: true });
      const order = await waitForStatus(customer, id, 'CANCELLED');
      assert.deepEqual(statuses(order), ['PENDING_PAYMENT', 'CANCELLED']);
      assert.equal(order.history[1].reason, 'Card declined');
    },
  ],
  [
    'restaurant rejection refunds, then cancels',
    async () => {
      const { id } = await placeOrder(customer);
      await waitForStatus(customer, id, 'PAID');
      await waitFor('rejection', async () => {
        const { status } = await http(`/kitchen/tickets/${id}/reject`, {
          method: 'POST',
          token: kitchen.token,
          body: JSON.stringify({ reason: 'Out of dough' }),
        });
        return status < 300;
      });
      const order = await waitForStatus(customer, id, 'CANCELLED');
      assert.deepEqual(statuses(order), ['PENDING_PAYMENT', 'PAID', 'REFUNDING', 'CANCELLED']);
    },
  ],
  [
    'no available courier refunds, then cancels',
    async () => {
      await courierOffline();
      const { id } = await placeOrder(customer);
      await waitForStatus(customer, id, 'PAID');
      await waitFor('acceptance', async () => {
        const { status } = await http(`/kitchen/tickets/${id}/accept`, { method: 'POST', token: kitchen.token });
        return status < 300;
      });
      const order = await waitForStatus(customer, id, 'CANCELLED');
      assert.ok(statuses(order).includes('REFUNDING'));
      assert.equal(order.history.at(-2).reason, 'No courier available nearby');
    },
  ],
  [
    'a duplicate Kafka event is applied once',
    async () => {
      const { id } = await placeOrder(customer);
      await waitForStatus(customer, id, 'PAID');
      const event = makeEvent(
        'order.ready',
        { orderId: id, restaurantId: DEMO.restaurants[0].restaurantId },
        randomUUID(),
      );
      const message = { key: id, value: JSON.stringify(event) };
      await producer.send({ topic: 'order.ready', messages: [message, message, message] });

      await waitFor('READY in history', async () => {
        const order = await api(`/orders/${id}`, { token: customer.token });
        return statuses(order).includes('READY');
      });
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const order = await api(`/orders/${id}`, { token: customer.token });
      assert.equal(statuses(order).filter((s) => s === 'READY').length, 1);
    },
  ],
  [
    'repeating an Idempotency-Key returns the same order, even concurrently',
    async () => {
      const key = randomUUID();
      const orders = await Promise.all([1, 2, 3, 4].map(() => placeOrder(customer, { key })));
      assert.equal(new Set(orders.map((o) => o.id)).size, 1);
      const all = await api('/orders', { token: customer.token });
      assert.equal(all.filter((o: { id: string }) => o.id === orders[0].id).length, 1);
    },
  ],
  [
    'a malformed event lands in the DLQ and does not block the topic',
    async () => {
      const admin = kafka.admin();
      await admin.connect();
      const total = async () =>
        (await admin.fetchTopicOffsets(dlqTopic('payment.done'))).reduce((sum, p) => sum + Number(p.high), 0);
      const before = await total();
      await producer.send({ topic: 'payment.done', messages: [{ value: 'this is not an event' }] });
      await waitFor('DLQ message', async () => (await total()) > before);
      await admin.disconnect();
      const { id } = await placeOrder(customer);
      await waitForStatus(customer, id, 'PAID');
    },
  ],
  [
    'gateway rejects missing, forged and foreign identities',
    async () => {
      assert.equal((await http('/orders')).status, 401);
      assert.equal((await http('/orders', { token: 'forged.jwt.token' })).status, 401);

      const spoof = await http('/kitchen/tickets', {
        token: customer.token,
        headers: { 'x-user-restaurant-id': DEMO.restaurants[0].restaurantId },
      });
      assert.equal(spoof.status, 403, 'a client cannot inject identity headers');

      const { id } = await placeOrder(customer);
      const email = `other-${randomUUID()}@demo.com`;
      await api('/auth/register', {
        method: 'POST',
        body: JSON.stringify({ email, password: 'password123', role: 'CUSTOMER' }),
      });
      const other = await login(email, 'password123');
      assert.equal((await http(`/orders/${id}`, { token: other.token })).status, 403);
    },
  ],
  [
    'a menu price change replicates to Order, and old orders keep their price',
    async () => {
      const { id, totalCents } = await placeOrder(customer);
      const patch = (priceCents: number) =>
        api('/restaurants/menu/pizza-margherita', {
          method: 'PATCH',
          token: kitchen.token,
          body: JSON.stringify({ priceCents }),
        });
      await patch(5000);
      try {
        await waitFor('the new price to reach Order', async () => {
          const order = await placeOrder(customer);
          return order.totalCents === 2 * 5000 + 1250;
        });
        const old = await api(`/orders/${id}`, { token: customer.token });
        assert.equal(old.totalCents, totalCents);
      } finally {
        await patch(1100);
      }
      await waitFor('the price to be restored', async () => {
        const order = await placeOrder(customer);
        return order.totalCents === 2 * 1100 + 1250;
      });
    },
  ],
  [
    'search read model finds restaurants despite a typo',
    async () => {
      const hits = await waitFor('search results', async () => {
        const results = await api('/search?q=margerita');
        return results.length ? results : null;
      });
      assert.equal(hits[0].name, 'Forno Kyiv');
    },
  ],
  [
    'analytics read model has counted the flows',
    async () => {
      await waitFor('analytics', async () => {
        const summary = await api('/analytics/summary', { token: customer.token });
        const count = (type: string) =>
          summary.eventCounts.find((e: { type: string }) => e.type === type)?.count ?? 0;
        return summary.revenueCents > 0 && count('delivery.completed') >= 1 && count('payment.refunded') >= 1;
      });
    },
  ],
];

async function main() {
  await producer.connect();
  customer = await login(DEMO.customer.email);
  courier = await login(DEMO.courier.email);
  kitchen = await login(DEMO.restaurants[0].email);

  let failed = 0;
  for (const [name, run] of tests) {
    const start = Date.now();
    try {
      await run();
      console.log(`PASS  ${name} (${Date.now() - start} ms)`);
    } catch (error) {
      failed++;
      console.error(`FAIL  ${name}\n      ${(error as Error).message}`);
    }
  }
  await producer.disconnect();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
}

void main();
