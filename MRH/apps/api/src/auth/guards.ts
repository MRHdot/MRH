import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { AuthService } from './auth.service';
import { AuthUser, IS_PUBLIC } from './auth.types';

const bearer = (req: any) => (req.headers.authorization ?? '').replace(/^Bearer /i, '') || null;

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private reflector: Reflector, private auth: AuthService) {}
  canActivate(ctx: ExecutionContext) {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;
    const req = ctx.switchToHttp().getRequest();
    const token = bearer(req);
    if (!token) throw new UnauthorizedException('Missing bearer token');
    req.user = this.auth.verifyAccessToken(token);
    return true;
  }
}

/** One guard, reused on every controller: @RequirePermission('leads.create'). */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private reflector: Reflector) {}
  canActivate(ctx: ExecutionContext) {
    const required = this.reflector.get<string>('permission', ctx.getHandler());
    if (!required) return true;
    const user: AuthUser | undefined = ctx.switchToHttp().getRequest().user;
    if (user && (user.permissions.includes('*') || user.permissions.includes(required))) return true;
    throw new ForbiddenException('You do not have permission to perform this action');
  }
}

/** Lead intake: portal webhooks / website form use x-api-key; staff may use a normal JWT. */
@Injectable()
export class LeadIntakeGuard implements CanActivate {
  constructor(private auth: AuthService, private config: ConfigService) {}
  canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    const key = req.headers['x-api-key'];
    if (key && key === this.config.get('PUBLIC_API_KEY')) {
      req.user = { id: 'system', role: 'public_intake', permissions: ['leads.create'] } as AuthUser;
      return true;
    }
    const token = bearer(req);
    if (!token) throw new UnauthorizedException('API key or bearer token required');
    const user = this.auth.verifyAccessToken(token);
    if (!user.permissions.includes('*') && !user.permissions.includes('leads.create')) throw new ForbiddenException();
    req.user = user;
    return true;
  }
}
