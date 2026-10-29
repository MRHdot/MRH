import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';

const RATE_LIMIT = 'rate_limit';

export const RateLimit = (limit: number, windowMs: number) => SetMetadata(RATE_LIMIT, { limit, windowMs });

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly buckets = new Map<string, { count: number; expiresAt: number }>();

  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext) {
    const config = this.reflector.getAllAndOverride<{ limit: number; windowMs: number }>(RATE_LIMIT, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!config) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const key = `${request.ip ?? request.socket.remoteAddress ?? 'unknown'}:${request.route?.path ?? request.path}`;
    const now = Date.now();
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.expiresAt <= now) {
      this.buckets.set(key, { count: 1, expiresAt: now + config.windowMs });
      this.pruneExpired(now);
      return true;
    }
    if (bucket.count >= config.limit) {
      throw new HttpException('Too many requests; try again later', HttpStatus.TOO_MANY_REQUESTS);
    }
    bucket.count += 1;
    return true;
  }

  private pruneExpired(now: number) {
    if (this.buckets.size < 10_000) return;
    for (const [key, bucket] of this.buckets) {
      if (bucket.expiresAt <= now) this.buckets.delete(key);
    }
    if (this.buckets.size >= 10_000) {
      const oldest = this.buckets.keys().next().value;
      if (oldest) this.buckets.delete(oldest);
    }
  }
}
