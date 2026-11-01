import { Controller, Get, Module, OnModuleDestroy } from '@nestjs/common';
import { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { IoAdapter } from '@nestjs/platform-socket.io';
import {
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import * as jwt from 'jsonwebtoken';
import { Server, ServerOptions, Socket } from 'socket.io';
import { ALL_EVENT_TYPES, config, EventEnvelope, EventPayload, jwtKey, JwtClaims } from '@food/contracts';
import { EventBus, Handlers } from '@food/kafka';
import { createLogger } from '@food/observability';

const log = createLogger('ws-gateway');
const publicKey = jwtKey('public');

/**
 * Publishes every room broadcast through Redis, so a client connected to
 * instance B still gets an event that instance A consumed from Kafka.
 */
class RedisIoAdapter extends IoAdapter {
  constructor(app: INestApplicationContext) {
    super(app);
  }

  createIOServer(port: number, options?: ServerOptions) {
    const server: Server = super.createIOServer(port, options);
    const pub = new Redis(config.redisUrl);
    server.adapter(createAdapter(pub, pub.duplicate()));
    return server;
  }
}

@WebSocketGateway({ cors: { origin: true } })
class LiveGateway implements OnGatewayInit, OnGatewayConnection, OnModuleDestroy {
  private readonly bus = new EventBus('ws-gateway');
  private server!: Server;

  afterInit(server: Server) {
    this.server = server;
    const forward = (event: EventEnvelope) => this.forward(event);
    const handlers = Object.fromEntries(ALL_EVENT_TYPES.map((type) => [type, forward])) as Handlers;
    // All instances share one group: exactly one consumes each event, and Redis fans it out.
    this.bus
      .connect()
      .then(() => this.bus.subscribe('ws-gateway', handlers))
      .catch((err) => {
        log.error({ err }, 'could not start the Kafka consumer');
        process.exit(1);
      });
  }

  async onModuleDestroy() {
    await this.bus.disconnect();
  }

  handleConnection(client: Socket) {
    try {
      const token = client.handshake.auth?.token as string;
      const claims = jwt.verify(token, publicKey, { algorithms: ['RS256'], issuer: 'food-auth' }) as JwtClaims;
      void client.join(`user:${claims.sub}`);
      if (claims.restaurantId) void client.join(`restaurant:${claims.restaurantId}`);
    } catch {
      client.emit('auth_error', 'Invalid token');
      client.disconnect(true);
    }
  }

  /** Learning aid behind any valid login. A real system would restrict this stream. */
  @SubscribeMessage('dev:subscribe')
  devSubscribe(@ConnectedSocket() client: Socket) {
    void client.join('dev');
  }

  private forward(event: EventEnvelope) {
    const safe = this.withoutPii(event);
    this.server.to('dev').emit('event', safe);

    if (event.type === 'order.status_changed') {
      const p = event.payload as EventPayload<'order.status_changed'>;
      const rooms = [`user:${p.customerId}`, `restaurant:${p.restaurantId}`];
      if (p.courierId) rooms.push(`user:${p.courierId}`);
      this.server.to(rooms).emit('event', safe);
    }
    if (event.type === 'courier.location') {
      const p = event.payload as EventPayload<'courier.location'>;
      this.server.to(`user:${p.customerId}`).emit('event', safe);
    }
    return Promise.resolve();
  }

  private withoutPii(event: EventEnvelope) {
    const { customerEmail: _removed, ...payload } = event.payload as { customerEmail?: string };
    return { ...event, payload };
  }
}

@Controller()
class HealthController {
  @Get('health')
  health() {
    return { status: 'ok', instance: process.env.PORT ?? '3010' };
  }
}

@Module({ controllers: [HealthController], providers: [LiveGateway] })
class AppModule {}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useWebSocketAdapter(new RedisIoAdapter(app));
  app.enableCors({ origin: true });
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3010));
}
void bootstrap();
