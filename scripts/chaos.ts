/**
 * Failure demos against the running stack. Each one breaks something and shows
 * what the design does about it. Requires infra and `pnpm dev`.
 */
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { DEMO } from '@food/contracts';
import { api, http, login, placeOrder, Session, waitForStatus } from './lib';

const compose = `docker compose -f ${join(__dirname, '../infra/docker-compose.yml')}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const statusOf = async (customer: Session, id: string) =>
  (await api(`/orders/${id}`, { token: customer.token })).status;

async function debeziumDown(customer: Session) {
  console.log('\n[1] Debezium down: orders commit, and their events wait safely in the WAL');
  execSync(`${compose} stop debezium`, { stdio: 'ignore' });
  try {
    const { id } = await placeOrder(customer);
    console.log('    Order accepted by the API while Debezium is stopped');
    await sleep(5_000);
    assert.equal(await statusOf(customer, id), 'PENDING_PAYMENT');
    console.log('    After 5 s it is still PENDING_PAYMENT: no event has reached Kafka');

    execSync(`${compose} start debezium`, { stdio: 'ignore' });
    await waitForStatus(customer, id, 'PAID', 50_000);
    console.log('    Debezium restarted from its saved position: order is PAID, nothing lost');
  } finally {
    execSync(`${compose} start debezium`, { stdio: 'ignore' });
  }
}

async function paymentFrozen(customer: Session) {
  console.log('\n[2] Payment frozen: events queue in Kafka, then process on resume');
  const pid = execSync('lsof -ti tcp:3004 -sTCP:LISTEN').toString().trim().split('\n')[0];
  process.kill(Number(pid), 'SIGSTOP');
  try {
    const orders = await Promise.all([1, 2, 3].map(() => placeOrder(customer)));
    await sleep(4_000);
    for (const { id } of orders) assert.equal(await statusOf(customer, id), 'PENDING_PAYMENT');
    console.log('    3 orders are waiting while the API still works');
    process.kill(Number(pid), 'SIGCONT');
    await Promise.all(orders.map(({ id }) => waitForStatus(customer, id, 'PAID', 50_000)));
    console.log('    Payment resumed from its committed offset: all 3 are PAID');
  } finally {
    try {
      process.kill(Number(pid), 'SIGCONT');
    } catch {
      // Already resumed and gone.
    }
  }
}

async function rateLimit() {
  console.log('\n[3] Login flood: the token bucket answers 429');
  const responses = await Promise.all(
    Array.from({ length: 40 }, () =>
      http('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: DEMO.customer.email, password: 'wrong-password' }),
      }),
    ),
  );
  const limited = responses.filter((r) => r.status === 429).length;
  assert.ok(limited > 0, 'expected some 429 responses');
  console.log(`    ${limited} of 40 attempts were limited before reaching Auth`);
}

async function main() {
  const customer = await login(DEMO.customer.email);
  await debeziumDown(customer);
  await paymentFrozen(customer);
  await rateLimit();
  console.log('\nAll chaos demos behaved as expected.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
