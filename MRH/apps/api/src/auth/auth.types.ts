import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface AuthUser { id: string; role: string; permissions: string[]; }

export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);
export const RequirePermission = (p: string) => SetMetadata('permission', p);
export const CurrentUser = createParamDecorator(
  (_d: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user,
);
