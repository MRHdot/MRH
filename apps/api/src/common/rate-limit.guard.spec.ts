import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RateLimitGuard } from './rate-limit.guard';

describe('RateLimitGuard', () => {
  const context = (ip: string) => ({
    getHandler: jest.fn(),
    getClass: jest.fn(),
    switchToHttp: () => ({
      getRequest: () => ({ ip, path: '/v1/auth/login', route: { path: '/auth/login' }, socket: {} }),
    }),
  }) as unknown as ExecutionContext;

  it('limits requests independently per client IP and route', () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue({ limit: 2, windowMs: 60_000 }) } as unknown as Reflector;
    const guard = new RateLimitGuard(reflector);
    expect(guard.canActivate(context('192.0.2.1'))).toBe(true);
    expect(guard.canActivate(context('192.0.2.1'))).toBe(true);
    expect(() => guard.canActivate(context('192.0.2.1'))).toThrow();
    expect(guard.canActivate(context('192.0.2.2'))).toBe(true);
  });
});
