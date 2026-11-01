import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const env = (name: string, fallback: string) => process.env[name] ?? fallback;

/** Defaults target a host-run service. Docker Compose overrides them through env vars. */
export const config = {
  kafkaBrokers: env('KAFKA_BROKERS', 'localhost:9094').split(','),
  redisUrl: env('REDIS_URL', 'redis://localhost:6390'),
  elasticsearchUrl: env('ELASTICSEARCH_URL', 'http://localhost:9200'),
  clickhouseUrl: env('CLICKHOUSE_URL', 'http://localhost:8123'),
  smtpHost: env('SMTP_HOST', 'localhost'),
  smtpPort: Number(env('SMTP_PORT', '1025')),
  orderGrpcUrl: env('ORDER_GRPC_URL', '127.0.0.1:50051'),
  services: {
    auth: env('AUTH_URL', 'http://localhost:3001'),
    restaurant: env('RESTAURANT_URL', 'http://localhost:3002'),
    delivery: env('DELIVERY_URL', 'http://localhost:3005'),
    search: env('SEARCH_URL', 'http://localhost:3007'),
    analytics: env('ANALYTICS_URL', 'http://localhost:3008'),
  },
  keysDir: env('KEYS_DIR', join(__dirname, '../../../infra/keys')),
};

/** Local dev reads key files. A deployed service gets the key through its environment. */
export const jwtKey = (kind: 'private' | 'public') =>
  process.env[`JWT_${kind.toUpperCase()}_KEY`] ?? readFileSync(join(config.keysDir, `jwt-${kind}.pem`), 'utf8');

export const databaseUrl = (service: string) =>
  env(
    'DATABASE_URL',
    `postgresql://${service}_user:${service}_pass@localhost:5544/${service}?schema=public`,
  );

export const ORDER_PROTO_PATH = join(__dirname, '../../../proto/order.proto');
export const GRPC_LOADER_OPTIONS = { keepCase: false, longs: String, defaults: true, oneofs: true };

/** Fixed IDs that tie the seeded accounts in Auth to the seeded restaurants. */
export const DEMO = {
  password: 'demo1234',
  customer: { id: '00000000-0000-4000-8000-000000000001', email: 'customer@demo.com' },
  courier: { id: '00000000-0000-4000-8000-000000000002', email: 'courier@demo.com' },
  restaurants: [
    {
      ownerId: '00000000-0000-4000-8000-000000000011',
      email: 'pizza@demo.com',
      restaurantId: '10000000-0000-4000-8000-000000000001',
    },
    {
      ownerId: '00000000-0000-4000-8000-000000000012',
      email: 'sushi@demo.com',
      restaurantId: '10000000-0000-4000-8000-000000000002',
    },
  ],
};

export type Role = 'CUSTOMER' | 'COURIER' | 'RESTAURANT';

export interface JwtClaims {
  sub: string;
  email: string;
  role: Role;
  restaurantId?: string;
}
