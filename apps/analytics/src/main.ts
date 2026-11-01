import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Controller, Get, Injectable, Module, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createClient } from '@clickhouse/client';
import { ALL_EVENT_TYPES, config, EventEnvelope } from '@food/contracts';
import { EventBus, Handlers } from '@food/kafka';

@Injectable()
class AnalyticsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly clickhouse = createClient({ url: config.clickhouseUrl, database: 'analytics' });
  private readonly bus = new EventBus('analytics');

  /** Compose runs this file on first boot. A deployed ClickHouse starts empty. */
  private async ensureSchema() {
    const admin = createClient({ url: config.clickhouseUrl });
    const sql = readFileSync(join(__dirname, '../../../infra/clickhouse/init.sql'), 'utf8')
      .replace(/--.*$/gm, '');
    for (const statement of sql.split(';').map((part) => part.trim()).filter(Boolean)) {
      await admin.command({ query: statement });
    }
    await admin.close();
  }

  async onApplicationBootstrap() {
    await this.ensureSchema();
    const record = (event: EventEnvelope) => this.record(event);
    const handlers = Object.fromEntries(
      // courier.location would flood this table and answers no question below.
      ALL_EVENT_TYPES.filter((type) => type !== 'courier.location').map((type) => [type, record]),
    ) as Handlers;
    await this.bus.connect();
    await this.bus.subscribe('analytics', handlers);
  }

  async onModuleDestroy() {
    await this.bus.disconnect();
    await this.clickhouse.close();
  }

  /**
   * One insert per event keeps the flow easy to follow. A production pipeline
   * batches: ClickHouse is built for few large inserts, not many tiny ones.
   */
  private async record(event: EventEnvelope) {
    const payload = event.payload as { orderId?: string; amountCents?: number };
    await this.clickhouse.insert({
      table: 'events',
      format: 'JSONEachRow',
      values: [
        {
          event_id: event.eventId,
          type: event.type,
          occurred_at: event.occurredAt.replace('T', ' ').replace('Z', ''),
          order_id: payload.orderId ?? '',
          correlation_id: event.correlationId,
          amount_cents: payload.amountCents ?? 0,
          payload: JSON.stringify(event.payload),
        },
      ],
    });
  }

  private async rows<T>(query: string) {
    const result = await this.clickhouse.query({ query, format: 'JSONEachRow' });
    return result.json<T>();
  }

  async summary() {
    // FINAL applies deduplication at read time, which is slower but exact.
    const [eventCounts, totals, delivery] = await Promise.all([
      this.rows<{ type: string; count: string }>(
        `SELECT type, count() AS count FROM events FINAL GROUP BY type ORDER BY count DESC`,
      ),
      this.rows<{ orders: string; revenue_cents: string; refunded_cents: string }>(`
        SELECT
          countIf(type = 'order.created') AS orders,
          sumIf(amount_cents, type = 'payment.done') AS revenue_cents,
          sumIf(amount_cents, type = 'payment.refunded') AS refunded_cents
        FROM events FINAL`),
      this.rows<{ avg_seconds: number | null }>(`
        SELECT avgOrNull(seconds) AS avg_seconds FROM (
          SELECT order_id,
            dateDiff('second',
              minIf(occurred_at, type = 'order.created'),
              maxIf(occurred_at, type = 'delivery.completed')) AS seconds
          FROM events FINAL
          WHERE order_id != ''
          GROUP BY order_id
          HAVING countIf(type = 'delivery.completed') > 0
        )`),
    ]);
    return {
      orders: Number(totals[0]?.orders ?? 0),
      revenueCents: Number(totals[0]?.revenue_cents ?? 0),
      refundedCents: Number(totals[0]?.refunded_cents ?? 0),
      avgDeliverySeconds: delivery[0]?.avg_seconds ?? null,
      eventCounts: eventCounts.map((row) => ({ type: row.type, count: Number(row.count) })),
    };
  }
}

@Controller()
class AnalyticsController {
  constructor(private readonly service: AnalyticsService) {}

  @Get('health')
  health() {
    return { status: 'ok' };
  }

  @Get('analytics/summary')
  summary() {
    return this.service.summary();
  }
}

@Module({ controllers: [AnalyticsController], providers: [AnalyticsService] })
class AppModule {}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3008));
}
void bootstrap();
