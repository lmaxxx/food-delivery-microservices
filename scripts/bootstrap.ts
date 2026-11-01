/**
 * One-time setup, safe to re-run. Requires `pnpm infra:up` first.
 * Generates JWT keys, creates DB tables and Kafka topics, registers Debezium.
 */
import { execSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Kafka, logLevel } from 'kafkajs';
import { ALL_EVENT_TYPES, COMPACTED_TOPICS, config, dlqTopic } from '@food/contracts';

const root = join(__dirname, '..');

function generateKeys() {
  const dir = join(root, 'infra/keys');
  mkdirSync(dir, { recursive: true });
  if (existsSync(join(dir, 'jwt-private.pem'))) return console.log('JWT keys: already exist');
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  writeFileSync(join(dir, 'jwt-private.pem'), privateKey, { mode: 0o600 });
  // Containers run as a different user and need to read this dev-only key.
  writeFileSync(join(dir, 'jwt-public.pem'), publicKey);
  console.log('JWT keys: generated');
}

function setupDatabases() {
  const services = [
    { app: 'auth', db: 'auth' },
    { app: 'restaurant', db: 'restaurants' },
    { app: 'order', db: 'orders' },
    { app: 'payment', db: 'payments' },
  ];
  for (const { app, db } of services) {
    execSync('pnpm exec prisma db push --skip-generate --accept-data-loss && pnpm exec prisma generate', {
      cwd: join(root, 'apps', app),
      stdio: 'pipe',
      env: {
        ...process.env,
        DATABASE_URL: `postgresql://${db}_user:${db}_pass@localhost:5544/${db}?schema=public`,
      },
    });
    console.log(`Database: ${db} ready`);
  }
}

export async function createTopics() {
  const admin = new Kafka({ brokers: config.kafkaBrokers, logLevel: logLevel.ERROR }).admin();
  await admin.connect();
  const existing = new Set(await admin.listTopics());
  const topics = ALL_EVENT_TYPES.flatMap((type) => [
    {
      topic: type,
      numPartitions: 3,
      replicationFactor: 1,
      configEntries: COMPACTED_TOPICS.includes(type)
        ? [{ name: 'cleanup.policy', value: 'compact' }]
        : [],
    },
    { topic: dlqTopic(type), numPartitions: 1, replicationFactor: 1, configEntries: [] },
  ]).filter(({ topic }) => !existing.has(topic));
  if (topics.length) await admin.createTopics({ topics, waitForLeaders: true });
  await admin.disconnect();
  console.log(`Kafka: created ${topics.length} topics`);
}

async function registerConnector() {
  const { name, config: connector } = JSON.parse(
    readFileSync(join(root, 'infra/debezium/orders-outbox.json'), 'utf8'),
  );
  // PUT creates or updates, so re-running is safe.
  const response = await fetch(`http://localhost:8083/connectors/${name}/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(connector),
  });
  if (!response.ok) throw new Error(`Debezium: ${response.status} ${await response.text()}`);
  console.log('Debezium: connector registered');
}

async function main() {
  generateKeys();
  setupDatabases();
  await createTopics();
  await registerConnector();
  console.log('Bootstrap complete. Next: pnpm dev');
}

// Also imported by the AWS-style deploy, which only needs createTopics.
if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
