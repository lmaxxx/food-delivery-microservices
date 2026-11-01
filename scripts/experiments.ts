/**
 * Load experiments against the Floci deployment. Each one states a claim about
 * microservices, then measures it. Usage: pnpm load <experiment> | pnpm load all
 */
import { execSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Kafka, logLevel } from 'kafkajs';
import { ALL_EVENT_TYPES } from '@food/contracts';

const ROOT = join(__dirname, '..');
const RESULTS = join(ROOT, 'load/results');
const TF = `terraform -chdir=${join(ROOT, 'infra/terraform/environments/local')}`;
const NO_LIMIT = 100000;
const LONG_TIMEOUT_MS = 3600000;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);

const kafka = new Kafka({ brokers: ['localhost:9300'], logLevel: logLevel.NOTHING });
const admin = kafka.admin();

async function lag(group: string) {
  const end = new Map<string, number>();
  for (const topic of ALL_EVENT_TYPES) {
    const offsets = await admin.fetchTopicOffsets(topic);
    for (const { partition, high } of offsets) end.set(`${topic}/${partition}`, Number(high));
  }
  const committed = await admin.fetchOffsets({ groupId: group, topics: ALL_EVENT_TYPES });
  let total = 0;
  for (const { topic, partitions } of committed) {
    for (const { partition, offset } of partitions) {
      // Offset -1 means this group has never read the topic, or it does not subscribe to it.
      if (Number(offset) >= 0) total += Math.max(0, (end.get(`${topic}/${partition}`) ?? 0) - Number(offset));
    }
  }
  return total;
}

const GROUPS = ['payment', 'order', 'notification', 'analytics', 'search-indexer'];
// Analytics inserts one row per event by design, so it falls far behind under load and
// catches up on its own time. Waiting for it would measure ClickHouse, not the order flow.
const CORE_GROUPS = ['payment', 'order', 'notification', 'search-indexer'];

/** Applies task settings. ECS replaces only the tasks whose definition changed. */
async function configure(settings: { rateLimit?: number; paymentDelayMs?: number; paymentCount?: number }) {
  const vars = [
    '-var run_services=true',
    settings.rateLimit ? `-var rate_limit_per_second=${settings.rateLimit}` : '',
    // No kitchen accepts test orders. Their timeouts would flood the system with refunds.
    settings.rateLimit ? `-var saga_restaurant_timeout_ms=${LONG_TIMEOUT_MS}` : '',
    `-var payment_delay_ms=${settings.paymentDelayMs ?? 0}`,
    `-var payment_count=${settings.paymentCount ?? 1}`,
  ].join(' ');
  execSync(`${TF} apply -input=false -auto-approve ${vars}`, { stdio: 'ignore' });
  await waitForSettings(settings);
  // A new task needs time to join its consumer group, and the login must really work.
  for (let i = 0; i < 60; i++) {
    const ok = await fetch('http://localhost:4400/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'customer@demo.com', password: 'demo1234' }),
    }).then((r) => r.ok, () => false);
    if (ok) break;
    await wait(2000);
  }
  await wait(15000);
}

function container(service: string) {
  const names = execSync(`docker ps --format '{{.Names}}'`).toString().split('\n');
  const name = names.find((n) => n.startsWith('floci-aws-ecs-') && n.endsWith(`-${service}`));
  if (!name) throw new Error(`No running task for ${service}`);
  return name;
}

function environmentOf(name: string) {
  return execSync(`docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' ${name}`).toString();
}

/** A setting that silently fails to apply would make every result meaningless. */
async function waitForSettings(settings: { rateLimit?: number; paymentDelayMs?: number; paymentCount?: number }) {
  const count = settings.paymentCount ?? 1;
  const delay = `PAYMENT_DELAY_MS=${settings.paymentDelayMs ?? 0}\n`;
  for (let i = 0; i < 90; i++) {
    const names = execSync(`docker ps --format '{{.Names}}'`).toString().split('\n');
    const payments = names.filter((n) => n.startsWith('floci-aws-ecs-') && n.endsWith('-payment'));
    const gateways = names.filter((n) => n.startsWith('floci-aws-ecs-') && n.endsWith('-api-gateway'));
    const rateOk =
      gateways.length === 1 &&
      environmentOf(gateways[0]).includes('RATE_CAPACITY=') === Boolean(settings.rateLimit);
    if (rateOk && payments.length === count && payments.every((n) => environmentOf(n).includes(delay))) return;
    await wait(2000);
  }
  throw new Error(`Settings did not reach the running tasks: ${JSON.stringify(settings)}`);
}

const docker = (command: string) => execSync(`docker ${command}`, { stdio: 'ignore' });

/** Rows Debezium has not delivered yet: a backlog in front of Kafka that lag cannot see. */
async function ordersInKafka() {
  return (await admin.fetchTopicOffsets('order.created')).reduce((sum, p) => sum + Number(p.high), 0);
}

async function drain(groups: string[], timeoutMs = 300000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const lags = await Promise.all(groups.map(lag));
    if (lags.every((value) => value === 0)) return Date.now() - start;
    await wait(1000);
  }
  throw new Error(`Lag did not drain within ${timeoutMs / 1000} s`);
}

interface Sample { at: number; lag: Record<string, number> }

/** Runs k6 while sampling lag every second, and runs timed actions such as a failure. */
async function runLoad(
  name: string,
  stages: { target: number; duration: string }[],
  options: { trackEvery?: number; actions?: { atSeconds: number; run: () => void }[] } = {},
) {
  mkdirSync(RESULTS, { recursive: true });
  const csv = join(RESULTS, `${name}.csv.gz`);
  const summaryFile = join(RESULTS, `${name}.json`);
  const start = Date.now();
  const samples: Sample[] = [];
  let running = true;
  let actionError: unknown;

  const sampler = (async () => {
    while (running) {
      const entries = await Promise.all(GROUPS.map(async (g) => [g, await lag(g)] as const));
      samples.push({ at: (Date.now() - start) / 1000, lag: Object.fromEntries(entries) });
      await wait(1000);
    }
  })();
  const timers = (options.actions ?? []).map(({ atSeconds, run }) =>
    setTimeout(() => {
      try {
        run();
      } catch (error) {
        actionError = error;
      }
    }, atSeconds * 1000),
  );

  try {
    await new Promise<void>((resolve, reject) => {
      const k6 = spawn(
        'k6',
        ['run', '--quiet', '--out', `csv=${csv}`, join(ROOT, 'load/orders.js')],
        {
          env: {
            ...process.env,
            STAGES: JSON.stringify(stages),
            TRACK_EVERY: String(options.trackEvery ?? 0),
            SUMMARY_FILE: summaryFile,
          },
          stdio: ['ignore', 'ignore', 'inherit'],
        },
      );
      k6.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`k6 exited with ${code}`))));
    });
  } finally {
    // Also on failure: a leftover timer would freeze a service after the run has ended.
    running = false;
    timers.forEach(clearTimeout);
    await sampler;
  }
  if (actionError) throw actionError;
  return { summary: JSON.parse(readFileSync(summaryFile, 'utf8')), samples, seconds: (Date.now() - start) / 1000, csv };
}

/** Per-phase latency and errors for order creation, from k6's raw samples. */
function phases(csv: string, bounds: { label: string; from: number; to: number }[]) {
  const lines = execSync(`gzip -dc ${csv}`, { maxBuffer: 1 << 30 }).toString().split('\n');
  const header = lines[0].split(',');
  const column = (name: string) => header.indexOf(name);
  const [metric, time, value, tagName, status] = ['metric_name', 'timestamp', 'metric_value', 'name', 'status'].map(column);
  const rows = lines
    .slice(1)
    .map((line) => line.split(','))
    .filter((c) => c[metric] === 'http_req_duration' && c[tagName] === 'create_order');
  const first = Math.min(...rows.map((c) => Number(c[time])));
  return bounds.map(({ label, from, to }) => {
    const inPhase = rows.filter((c) => {
      const at = Number(c[time]) - first;
      return at >= from && at < to;
    });
    const durations = inPhase.map((c) => Number(c[value])).sort((a, b) => a - b);
    const failed = inPhase.filter((c) => !c[status].startsWith('2')).length;
    return {
      phase: label,
      requests: inPhase.length,
      errorPercent: inPhase.length ? Number(((failed / inPhase.length) * 100).toFixed(1)) : 0,
      p50ms: Math.round(durations[Math.floor(durations.length * 0.5)] ?? 0),
      p95ms: Math.round(durations[Math.floor(durations.length * 0.95)] ?? 0),
    };
  });
}

const peak = (samples: Sample[], group: string) => Math.max(0, ...samples.map((s) => s.lag[group] ?? 0));

const experiments: Record<string, { claim: string; run: () => Promise<unknown> }> = {
  baseline: {
    claim: 'The cost: how latency and async delay grow with load',
    async run() {
      await configure({ rateLimit: NO_LIMIT });
      const stages = [
        { target: 5, duration: '30s' },
        { target: 20, duration: '30s' },
        { target: 50, duration: '30s' },
        { target: 100, duration: '30s' },
      ];
      const { summary, samples, csv } = await runLoad('baseline', stages, { trackEvery: 10 });
      const drainedMs = await drain(CORE_GROUPS);
      return {
        phases: phases(csv, [
          { label: 'ramp to 5/s', from: 0, to: 30 },
          { label: 'ramp to 20/s', from: 30, to: 60 },
          { label: 'ramp to 50/s', from: 60, to: 90 },
          { label: 'ramp to 100/s', from: 90, to: 120 },
        ]),
        orderToPaid: summary.metrics.order_to_paid_ms?.values,
        peakLag: Object.fromEntries(GROUPS.map((g) => [g, peak(samples, g)])),
        drainedAfterLoadSeconds: drainedMs / 1000,
      };
    },
  },
  spike: {
    claim: 'A spike becomes Kafka backlog instead of an API outage',
    async run() {
      await configure({ rateLimit: NO_LIMIT, paymentDelayMs: 100 });
      const stages = [
        { target: 5, duration: '20s' },
        { target: 60, duration: '5s' },
        { target: 60, duration: '20s' },
        { target: 5, duration: '5s' },
        { target: 5, duration: '20s' },
      ];
      const createdBefore = await ordersInKafka();
      const { summary, samples, csv } = await runLoad('spike', stages);
      const placed = summary.metrics.http_reqs.values.count - 1;
      // The outbox relay may still be delivering after the load stops, so wait for all of it.
      const relayStart = Date.now();
      while ((await ordersInKafka()) - createdBefore < placed * 0.99 && Date.now() - relayStart < 300000) await wait(1000);
      const drainedMs = (await drain(['payment'])) + (Date.now() - relayStart);
      return {
        phases: phases(csv, [
          { label: 'before spike, 5/s', from: 0, to: 20 },
          { label: 'spike, 60/s', from: 25, to: 45 },
          { label: 'after spike, 5/s', from: 50, to: 70 },
        ]),
        peakPaymentLag: peak(samples, 'payment'),
        paymentDrainedAfterLoadSeconds: drainedMs / 1000,
      };
    },
  },
  failure: {
    claim: 'Failures stay isolated: orders keep flowing while services are down',
    async run() {
      await configure({ rateLimit: NO_LIMIT });
      const payment = container('payment');
      const stages = [{ target: 10, duration: '100s' }];
      try {
        const { samples, csv } = await runLoad('failure', stages, {
          actions: [
            {
              atSeconds: 30,
              run: () => {
                log('Freezing Payment, killing search-indexer and analytics');
                docker(`pause ${payment}`);
                docker(`kill ${container('search-indexer')} ${container('analytics')}`);
              },
            },
            {
              atSeconds: 60,
              run: () => {
                log('Unfreezing Payment');
                docker(`unpause ${payment}`);
              },
            },
          ],
        });
        const drainedMs = await drain(['payment', 'order', 'search-indexer']);
        return {
          phases: phases(csv, [
            { label: 'healthy', from: 0, to: 30 },
            { label: 'Payment frozen, 2 services killed', from: 30, to: 60 },
            { label: 'recovering', from: 60, to: 100 },
          ]),
          peakLag: Object.fromEntries(GROUPS.map((g) => [g, peak(samples, g)])),
          drainedAfterLoadSeconds: drainedMs / 1000,
        };
      } finally {
        try {
          docker(`unpause ${payment}`);
        } catch {
          // Already running.
        }
      }
    },
  },
  scaling: {
    claim: 'Scaling only the bottleneck: Payment alone, from 1 to 3 tasks',
    async run() {
      const results = [];
      for (const paymentCount of [1, 3]) {
        await configure({ rateLimit: NO_LIMIT, paymentDelayMs: 200, paymentCount });
        const { samples, seconds } = await runLoad(`scaling-${paymentCount}`, [{ target: 10, duration: '20s' }]);
        const drainedMs = await drain(['payment']);
        results.push({
          paymentTasks: paymentCount,
          peakPaymentLag: peak(samples, 'payment'),
          totalSecondsToProcessEverything: Number((seconds + drainedMs / 1000).toFixed(1)),
        });
      }
      return results;
    },
  },
  'slow-consumer': {
    claim: 'One stuck consumer does not slow anyone else',
    async run() {
      await configure({ rateLimit: NO_LIMIT });
      const notification = container('notification');
      try {
        const { samples, csv } = await runLoad('slow-consumer', [{ target: 10, duration: '60s' }], {
          actions: [{ atSeconds: 15, run: () => docker(`pause ${notification}`) }],
        });
        const lagAtEnd = samples[samples.length - 1].lag;
        docker(`unpause ${notification}`);
        const drainedMs = await drain(['notification']);
        return {
          phases: phases(csv, [
            { label: 'healthy', from: 0, to: 15 },
            { label: 'Notification frozen', from: 15, to: 60 },
          ]),
          lagAtEnd,
          notificationDrainedAfterUnfreezeSeconds: drainedMs / 1000,
        };
      } finally {
        try {
          docker(`unpause ${notification}`);
        } catch {
          // Already running.
        }
      }
    },
  },
};

async function main() {
  const requested = process.argv[2];
  if (!requested || (requested !== 'all' && !experiments[requested])) {
    console.log(`Usage: pnpm load <${Object.keys(experiments).join(' | ')} | all>`);
    process.exit(1);
  }
  await admin.connect();
  const names = requested === 'all' ? Object.keys(experiments) : [requested];
  try {
    for (const name of names) {
      log(`${name}: ${experiments[name].claim}`);
      const result = await experiments[name].run();
      mkdirSync(RESULTS, { recursive: true });
      writeFileSync(join(RESULTS, `${name}-result.json`), JSON.stringify(result, null, 2));
      console.log(JSON.stringify(result, null, 2));
    }
  } finally {
    log('Restoring default settings');
    await configure({});
    await admin.disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
