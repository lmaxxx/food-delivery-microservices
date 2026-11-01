// Places orders at a controlled rate. scripts/experiments.ts runs this, or run it directly:
//   k6 run -e STAGES='[{"target":10,"duration":"30s"}]' load/orders.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const API = __ENV.API_URL || 'http://localhost:4400';
const STAGES = JSON.parse(__ENV.STAGES);
// Follow every Nth order until it is PAID. Polling is itself load, so most orders skip it.
const TRACK_EVERY = Number(__ENV.TRACK_EVERY || 0);

const orderToPaid = new Trend('order_to_paid_ms', true);
const createFailed = new Rate('create_failed');
const JSON_HEADERS = { 'content-type': 'application/json' };

export const options = {
  scenarios: {
    orders: {
      // Arrival rate holds the target even when the system slows down, unlike a fixed
      // number of looping users, who would wait and quietly reduce the load.
      executor: 'ramping-arrival-rate',
      startRate: STAGES[0].target,
      timeUnit: '1s',
      preAllocatedVUs: 50,
      maxVUs: 400,
      stages: STAGES,
    },
  },
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  const response = http.post(
    `${API}/auth/login`,
    JSON.stringify({ email: 'customer@demo.com', password: 'demo1234' }),
    { headers: JSON_HEADERS },
  );
  check(response, { 'login worked': (r) => r.status < 300 });
  return { headers: { ...JSON_HEADERS, authorization: `Bearer ${response.json('accessToken')}` } };
}

export default function ({ headers }) {
  const response = http.post(
    `${API}/orders`,
    JSON.stringify({
      restaurantId: '10000000-0000-4000-8000-000000000001',
      items: [{ menuItemId: 'pizza-margherita', quantity: 1 }],
      delivery: { address: 'Khreshchatyk 1, Kyiv', lat: 50.4475, lng: 30.5222 },
    }),
    {
      headers: { ...headers, 'idempotency-key': `${__VU}-${__ITER}-${Date.now()}` },
      tags: { name: 'create_order' },
      timeout: '15s',
    },
  );
  const ok = response.status >= 200 && response.status < 300;
  createFailed.add(!ok);
  if (!ok || !TRACK_EVERY || __ITER % TRACK_EVERY !== 0) return;

  const start = Date.now();
  const id = response.json('id');
  while (Date.now() - start < 90000) {
    sleep(0.25);
    const poll = http.get(`${API}/orders/${id}`, { headers, tags: { name: 'poll_order' } });
    if (poll.status === 200 && poll.json('status') !== 'PENDING_PAYMENT') {
      orderToPaid.add(Date.now() - start);
      return;
    }
  }
}

export function handleSummary(data) {
  return { [__ENV.SUMMARY_FILE || 'load/results/summary.json']: JSON.stringify(data) };
}
