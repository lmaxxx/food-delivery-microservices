import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { correlationMiddleware } from '@food/observability';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Behind a load balancer, req.ip would be the balancer's address and all clients would
  // share one rate limit. Set this to the number of proxies in front of the gateway.
  const trustedProxies = Number(process.env.TRUSTED_PROXIES ?? 0);
  if (trustedProxies > 0) app.set('trust proxy', trustedProxies);
  app.use(correlationMiddleware);
  app.enableCors({ origin: true, exposedHeaders: ['x-correlation-id', 'retry-after'] });
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 4400));
}
void bootstrap();
