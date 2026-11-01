import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Injectable,
  Module,
  OnModuleInit,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { z } from 'zod';
import { databaseUrl, DEMO, jwtKey, JwtClaims, Role } from '@food/contracts';
import { correlationMiddleware } from '@food/observability';
import { PrismaClient } from './generated/prisma';

const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  // Restaurant accounts are provisioned by the seed, never by self-registration.
  role: z.enum(['CUSTOMER', 'COURIER']),
});
const LoginSchema = z.object({ email: z.string().email(), password: z.string() });

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new BadRequestException(result.error.issues);
  return result.data;
}

@Injectable()
class AuthService implements OnModuleInit {
  private readonly prisma = new PrismaClient({ datasourceUrl: databaseUrl('auth') });
  // Only this service holds the private key. Others can verify tokens but never mint them.
  private readonly privateKey = jwtKey('private');

  async onModuleInit() {
    const passwordHash = await bcrypt.hash(DEMO.password, 10);
    const accounts: { id: string; email: string; role: Role; restaurantId?: string }[] = [
      { ...DEMO.customer, role: 'CUSTOMER' },
      { ...DEMO.courier, role: 'COURIER' },
      ...DEMO.restaurants.map((r) => ({
        id: r.ownerId,
        email: r.email,
        role: 'RESTAURANT' as const,
        restaurantId: r.restaurantId,
      })),
    ];
    for (const account of accounts) {
      await this.prisma.user.upsert({
        where: { id: account.id },
        create: { ...account, passwordHash },
        update: {},
      });
    }
  }

  async register(input: z.infer<typeof RegisterSchema>) {
    const existing = await this.prisma.user.findUnique({ where: { email: input.email } });
    if (existing) throw new ConflictException('Email already registered');
    const user = await this.prisma.user.create({
      data: {
        email: input.email,
        role: input.role,
        passwordHash: await bcrypt.hash(input.password, 10),
      },
    });
    return this.issue(user);
  }

  async login(input: z.infer<typeof LoginSchema>) {
    const user = await this.prisma.user.findUnique({ where: { email: input.email } });
    if (!user || !(await bcrypt.compare(input.password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid email or password');
    }
    return this.issue(user);
  }

  private issue(user: { id: string; email: string; role: string; restaurantId: string | null }) {
    const claims: Omit<JwtClaims, 'sub'> = {
      email: user.email,
      role: user.role as Role,
      ...(user.restaurantId ? { restaurantId: user.restaurantId } : {}),
    };
    const accessToken = jwt.sign(claims, this.privateKey, {
      algorithm: 'RS256',
      subject: user.id,
      expiresIn: '8h',
      issuer: 'food-auth',
    });
    return { accessToken, user: { id: user.id, ...claims } };
  }
}

@Controller()
class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Get('health')
  health() {
    return { status: 'ok' };
  }

  @Post('auth/register')
  register(@Body() body: unknown) {
    return this.auth.register(parse(RegisterSchema, body));
  }

  @Post('auth/login')
  login(@Body() body: unknown) {
    return this.auth.login(parse(LoginSchema, body));
  }
}

@Module({ controllers: [AuthController], providers: [AuthService] })
class AppModule {}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.use(correlationMiddleware);
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3001));
}
void bootstrap();
