import { Controller, Get, Injectable, Module, OnApplicationBootstrap, OnModuleDestroy, Query } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { config, EventEnvelope } from '@food/contracts';
import { EventBus } from '@food/kafka';

const INDEX = 'restaurants';

/** Plain REST, so the same code works on Elasticsearch locally and OpenSearch on AWS. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function es(method: string, path: string, body?: unknown): Promise<any> {
  const response = await fetch(`${config.elasticsearchUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (method === 'HEAD') return { exists: response.ok };
  const result = await response.json();
  if (!response.ok) throw new Error(`Search engine: ${response.status} ${JSON.stringify(result)}`);
  return result;
}

@Injectable()
class SearchService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly bus = new EventBus('search-indexer');

  async onApplicationBootstrap() {
    if (!(await es('HEAD', `/${INDEX}`)).exists) {
      await es('PUT', `/${INDEX}`, {
        // One node cannot host a replica of its own shard.
        settings: { number_of_replicas: 0 },
        mappings: {
          properties: {
            name: { type: 'text' },
            cuisine: { type: 'text' },
            menuText: { type: 'text' },
            // Returned with results, but not searchable.
            menu: { type: 'object', enabled: false },
          },
        },
      });
    }
    await this.bus.connect();
    await this.bus.subscribe('search-indexer', {
      'restaurant.updated': (event) => this.index(event),
    });
  }

  async onModuleDestroy() {
    await this.bus.disconnect();
  }

  /** Writing by a fixed document ID makes the handler naturally idempotent. */
  private async index({ payload }: EventEnvelope<'restaurant.updated'>) {
    await es('PUT', `/${INDEX}/_doc/${payload.restaurantId}?refresh=true`, {
      ...payload,
      menuText: payload.menu.map((item) => `${item.name} ${item.description}`).join(' '),
    });
  }

  async search(q: string) {
    const result = await es('POST', `/${INDEX}/_search`, {
      size: 20,
      query: q.trim()
        ? { multi_match: { query: q, fields: ['name^3', 'cuisine^2', 'menuText'], fuzziness: 'AUTO' } }
        : { match_all: {} },
    });
    return result.hits.hits.map((hit: { _score: number; _source: object }) => ({
      score: hit._score,
      ...hit._source,
    }));
  }
}

@Controller()
class SearchController {
  constructor(private readonly service: SearchService) {}

  @Get('health')
  health() {
    return { status: 'ok' };
  }

  @Get('search')
  search(@Query('q') q = '') {
    return this.service.search(q);
  }
}

@Module({ controllers: [SearchController], providers: [SearchService] })
class AppModule {}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3007));
}
void bootstrap();
