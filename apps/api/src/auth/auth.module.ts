import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { LeadIntakeGuard } from './guards';
import { RateLimitGuard } from '../common/rate-limit.guard';

@Global()
@Module({
  imports: [JwtModule.registerAsync({
    global: true, inject: [ConfigService],
    useFactory: (c: ConfigService) => ({ secret: c.getOrThrow('JWT_ACCESS_SECRET'), signOptions: { expiresIn: '15m' } }),
  })],
  controllers: [AuthController],
  providers: [AuthService, LeadIntakeGuard, RateLimitGuard],
  exports: [AuthService, LeadIntakeGuard],
})
export class AuthModule {}
