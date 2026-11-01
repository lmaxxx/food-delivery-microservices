import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Injectable,
  Module,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Post,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import Redis from 'ioredis';
import { z } from 'zod';
import { config, EventEnvelope, EventType } from '@food/contracts';
import { EventBus, Handlers } from '@food/kafka';
import { correlationMiddleware } from '@food/observability';

const GEO_KEY = 'couriers:geo';
const SEARCH_RADIUS_KM = 50;
const ALIVE_SECONDS = 120;
const DAY_SECONDS = 86_400;

const keys = {
  alive: (courierId: string) => `courier:${courierId}:alive`,
  /** Holding this key is what makes a courier busy. */
  reservation: (courierId: string) => `courier:${courierId}:job`,
  job: (orderId: string) => `job:${orderId}`,
  ready: (orderId: string) => `order:${orderId}:ready`,
  processed: (eventId: string) => `processed:delivery:${eventId}`,
};

interface Job {
  orderId: string;
  courierId: string;
  customerId: string;
  restaurantId: string;
  pickup: { lat: number; lng: number };
  delivery: { lat: number; lng: number };
  status: 'ASSIGNED' | 'PICKED_UP';
}

const LocationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

@Injectable()
class DeliveryService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly redis = new Redis(config.redisUrl);
  private readonly bus = new EventBus('delivery');

  async onApplicationBootstrap() {
    await this.bus.connect();
    const handlers: Handlers = {
      'order.accepted': this.once((event) => this.assign(event as EventEnvelope<'order.accepted'>)),
      'order.ready': async (event) => {
        await this.redis.set(keys.ready(event.payload.orderId), '1', 'EX', DAY_SECONDS);
      },
      'order.status_changed': this.once((event) =>
        this.onStatusChanged(event as EventEnvelope<'order.status_changed'>),
      ),
    };
    await this.bus.subscribe('delivery', handlers);
  }

  async onModuleDestroy() {
    await this.bus.disconnect();
    this.redis.disconnect();
  }

  /** Redis idempotency: claim first, and release the claim on failure so a retry can run. */
  private once<T extends EventType>(handler: (event: EventEnvelope<T>) => Promise<void>) {
    return async (event: EventEnvelope<T>) => {
      const key = keys.processed(event.eventId);
      const claimed = await this.redis.set(key, '1', 'EX', DAY_SECONDS, 'NX');
      if (!claimed) return;
      try {
        await handler(event);
      } catch (error) {
        await this.redis.del(key);
        throw error;
      }
    };
  }

  private async assign({ payload }: EventEnvelope<'order.accepted'>) {
    const { orderId, pickup } = payload;
    const nearby = (await this.redis.geosearch(
      GEO_KEY,
      'FROMLONLAT',
      pickup.lng,
      pickup.lat,
      'BYRADIUS',
      SEARCH_RADIUS_KM,
      'km',
      'ASC',
      'WITHDIST',
    )) as [string, string][];

    for (const [courierId, distance] of nearby) {
      if (!(await this.redis.exists(keys.alive(courierId)))) {
        await this.redis.zrem(GEO_KEY, courierId);
        continue;
      }
      // SET NX is atomic: two orders racing for one courier cannot both win.
      const reserved = await this.redis.set(keys.reservation(courierId), orderId, 'EX', DAY_SECONDS, 'NX');
      if (!reserved) continue;

      const job: Job = {
        orderId,
        courierId,
        customerId: payload.customerId,
        restaurantId: payload.restaurantId,
        pickup,
        delivery: payload.delivery,
        status: 'ASSIGNED',
      };
      await this.redis.set(keys.job(orderId), JSON.stringify(job), 'EX', DAY_SECONDS);
      await this.bus.publish('courier.assigned', orderId, {
        orderId,
        courierId,
        customerId: payload.customerId,
        distanceKm: Number(distance),
      });
      return;
    }
    await this.bus.publish('courier.unavailable', orderId, {
      orderId,
      reason: 'No courier available nearby',
    });
  }

  private async onStatusChanged({ payload }: EventEnvelope<'order.status_changed'>) {
    if (payload.status === 'CANCELLED' || payload.status === 'REFUNDING') {
      const job = await this.loadJob(payload.orderId);
      if (job) await this.release(job);
    }
  }

  private async loadJob(orderId: string) {
    const raw = await this.redis.get(keys.job(orderId));
    return raw ? (JSON.parse(raw) as Job) : null;
  }

  private async release(job: Job) {
    await this.redis.del(keys.reservation(job.courierId), keys.job(job.orderId));
  }

  private async currentJob(courierId: string) {
    const orderId = await this.redis.get(keys.reservation(courierId));
    return orderId ? this.loadJob(orderId) : null;
  }

  async updateLocation(courierId: string, lat: number, lng: number) {
    await this.redis.geoadd(GEO_KEY, lng, lat, courierId);
    await this.redis.set(keys.alive(courierId), '1', 'EX', ALIVE_SECONDS);
    const job = await this.currentJob(courierId);
    if (job) {
      await this.bus.publish('courier.location', job.orderId, {
        orderId: job.orderId,
        courierId,
        customerId: job.customerId,
        lat,
        lng,
      });
    }
    return { online: true };
  }

  async goOffline(courierId: string) {
    if (await this.currentJob(courierId)) throw new ConflictException('Finish the current job first');
    await this.redis.zrem(GEO_KEY, courierId);
    await this.redis.del(keys.alive(courierId));
    return { online: false };
  }

  async jobFor(courierId: string) {
    const job = await this.currentJob(courierId);
    if (!job) return { job: null };
    return { job: { ...job, ready: Boolean(await this.redis.exists(keys.ready(job.orderId))) } };
  }

  async pickUp(courierId: string) {
    const job = await this.currentJob(courierId);
    if (!job || job.status !== 'ASSIGNED') throw new ConflictException('No job to pick up');
    if (!(await this.redis.exists(keys.ready(job.orderId)))) {
      throw new ConflictException('Food is not ready yet');
    }
    job.status = 'PICKED_UP';
    await this.redis.set(keys.job(job.orderId), JSON.stringify(job), 'EX', DAY_SECONDS);
    await this.bus.publish('delivery.picked_up', job.orderId, {
      orderId: job.orderId,
      courierId,
      customerId: job.customerId,
    });
    return job;
  }

  async complete(courierId: string) {
    const job = await this.currentJob(courierId);
    if (!job || job.status !== 'PICKED_UP') throw new ConflictException('Nothing to deliver');
    await this.bus.publish('delivery.completed', job.orderId, {
      orderId: job.orderId,
      courierId,
      customerId: job.customerId,
    });
    await this.release(job);
    return { delivered: job.orderId };
  }
}

function courier(role?: string, id?: string) {
  if (role !== 'COURIER' || !id) throw new ForbiddenException('Courier account required');
  return id;
}

@Controller()
class DeliveryController {
  constructor(private readonly service: DeliveryService) {}

  @Get('health')
  health() {
    return { status: 'ok' };
  }

  @Post('courier/location')
  location(
    @Headers('x-user-role') role: string | undefined,
    @Headers('x-user-id') id: string | undefined,
    @Body() body: unknown,
  ) {
    const parsed = LocationSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.service.updateLocation(courier(role, id), parsed.data.lat, parsed.data.lng);
  }

  @Post('courier/offline')
  offline(@Headers('x-user-role') role?: string, @Headers('x-user-id') id?: string) {
    return this.service.goOffline(courier(role, id));
  }

  @Get('courier/job')
  job(@Headers('x-user-role') role?: string, @Headers('x-user-id') id?: string) {
    return this.service.jobFor(courier(role, id));
  }

  @Post('courier/job/pickup')
  pickup(@Headers('x-user-role') role?: string, @Headers('x-user-id') id?: string) {
    return this.service.pickUp(courier(role, id));
  }

  @Post('courier/job/deliver')
  deliver(@Headers('x-user-role') role?: string, @Headers('x-user-id') id?: string) {
    return this.service.complete(courier(role, id));
  }
}

@Module({ controllers: [DeliveryController], providers: [DeliveryService] })
class AppModule {}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.use(correlationMiddleware);
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3005));
}
void bootstrap();
