import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  OnModuleDestroy,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request, Response } from 'express';
import Redis from 'ioredis';
import * as jwt from 'jsonwebtoken';
import { config, jwtKey, JwtClaims } from '@food/contracts';
import { createLogger } from '@food/observability';

const log = createLogger('api-gateway');
const publicKey = jwtKey('public');

export const Public = () => SetMetadata('public', true);

export type AuthedRequest = Request & { user?: JwtClaims };

/** Authentication happens once, here at the edge. Services receive identity as headers. */
@Injectable()
export class JwtGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>('public', [
      context.getHandler(),
      context.getClass(),
    ]);
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;

    if (header?.startsWith('Bearer ')) {
      try {
        req.user = jwt.verify(header.slice(7), publicKey, {
          algorithms: ['RS256'], // Pinned: never let the token pick its own algorithm.
          issuer: 'food-auth',
        }) as JwtClaims;
      } catch {
        throw new UnauthorizedException('Invalid or expired token');
      }
    }
    if (!req.user && !isPublic) throw new UnauthorizedException('Bearer token required');
    return true;
  }
}

/**
 * Token bucket. Each client's bucket refills at a steady rate, and each request
 * spends one token. The Lua script runs atomically in Redis, so all gateway
 * instances share one accurate limit.
 */
const TOKEN_BUCKET = `
local key, capacity, refill_per_sec, now = KEYS[1], tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
local bucket = redis.call('HMGET', key, 'tokens', 'at')
local tokens = tonumber(bucket[1]) or capacity
local at = tonumber(bucket[2]) or now
tokens = math.min(capacity, tokens + (now - at) / 1000 * refill_per_sec)
local allowed = tokens >= 1
if allowed then tokens = tokens - 1 end
redis.call('HSET', key, 'tokens', tokens, 'at', now)
redis.call('PEXPIRE', key, math.ceil(capacity / refill_per_sec * 1000))
return { allowed and 1 or 0, tostring(tokens) }
`;

const LIMITS = {
  // Login is the brute-force target, so it gets a far stricter limit.
  auth: {
    capacity: Number(process.env.RATE_AUTH_CAPACITY ?? 20),
    refillPerSec: Number(process.env.RATE_AUTH_REFILL ?? 1),
  },
  default: {
    capacity: Number(process.env.RATE_CAPACITY ?? 200),
    refillPerSec: Number(process.env.RATE_REFILL ?? 50),
  },
};

@Injectable()
export class RateLimitGuard implements CanActivate, OnModuleDestroy {
  private readonly redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 1 });

  onModuleDestroy() {
    this.redis.disconnect();
  }

  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    const bucket = req.path.startsWith('/auth') ? 'auth' : 'default';
    const limit = LIMITS[bucket];

    let result: [number, string];
    try {
      result = (await this.redis.eval(
        TOKEN_BUCKET,
        1,
        `ratelimit:${bucket}:${req.ip}`,
        limit.capacity,
        limit.refillPerSec,
        Date.now(),
      )) as [number, string];
    } catch (err) {
      // Fail open: a Redis outage should not take the whole API down.
      log.error({ err }, 'rate limiter unavailable');
      return true;
    }

    res.setHeader('x-ratelimit-remaining', Math.floor(Number(result[1])));
    if (result[0] === 1) return true;
    res.setHeader('retry-after', Math.ceil(1 / limit.refillPerSec));
    throw new HttpException('Too many requests', HttpStatus.TOO_MANY_REQUESTS);
  }
}
