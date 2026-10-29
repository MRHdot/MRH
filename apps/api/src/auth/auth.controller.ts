import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { IsEmail, IsString, MinLength } from 'class-validator';
import { RateLimit, RateLimitGuard } from '../common/rate-limit.guard';
import { AuthService } from './auth.service';
import { AuthUser, CurrentUser, Public } from './auth.types';

class LoginDto { @IsEmail() email: string; @IsString() @MinLength(8) password: string; }
class RefreshDto { @IsString() refreshToken: string; }

@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}
  @Public() @RateLimit(10, 15 * 60_000) @UseGuards(RateLimitGuard) @Post('login')
  login(@Body() d: LoginDto) { return this.auth.login(d.email, d.password); }
  @Public() @Post('refresh') refresh(@Body() d: RefreshDto) { return this.auth.refresh(d.refreshToken); }
  @Post('logout') async logout(@Body() d: RefreshDto) { await this.auth.logout(d.refreshToken); return { ok: true }; }
  @Get('me') me(@CurrentUser() u: AuthUser) { return u; }
}
