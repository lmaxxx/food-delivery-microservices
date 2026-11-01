import { Controller, Get, Injectable, Module, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import * as nodemailer from 'nodemailer';
import { config, EventEnvelope, OrderStatus } from '@food/contracts';
import { EventBus } from '@food/kafka';
import { createLogger } from '@food/observability';

const log = createLogger('notification');

const MESSAGES: Partial<Record<OrderStatus, string>> = {
  ACCEPTED: 'The restaurant accepted your order and started cooking.',
  PICKED_UP: 'Your courier has picked up your order.',
  DELIVERED: 'Your order was delivered. Enjoy your meal!',
  CANCELLED: 'Your order was cancelled.',
};

@Injectable()
class NotificationService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly bus = new EventBus('notification');
  private readonly mailer = nodemailer.createTransport({ host: config.smtpHost, port: config.smtpPort });
  /**
   * In-memory dedup is the weakest option: a restart forgets it, so a redelivery
   * after a restart can send a second email. Acceptable for a notification.
   */
  private readonly seen = new Set<string>();

  async onApplicationBootstrap() {
    await this.bus.connect();
    await this.bus.subscribe('notification', {
      'order.status_changed': (event) => this.onStatusChanged(event),
    });
  }

  async onModuleDestroy() {
    await this.bus.disconnect();
  }

  private async onStatusChanged({ eventId, payload }: EventEnvelope<'order.status_changed'>) {
    const message = MESSAGES[payload.status];
    if (!message || this.seen.has(eventId)) return;

    await this.mailer.sendMail({
      from: 'orders@food-delivery.local',
      to: payload.customerEmail,
      subject: `Order ${payload.orderId.slice(0, 8)}: ${payload.status}`,
      text: payload.reason ? `${message}\nReason: ${payload.reason}` : message,
    });
    log.info({ orderId: payload.orderId, status: payload.status }, 'simulated push sent');

    this.seen.add(eventId);
    if (this.seen.size > 10_000) this.seen.clear();
  }
}

@Controller()
class HealthController {
  @Get('health')
  health() {
    return { status: 'ok' };
  }
}

@Module({ controllers: [HealthController], providers: [NotificationService] })
class AppModule {}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3006));
}
void bootstrap();
