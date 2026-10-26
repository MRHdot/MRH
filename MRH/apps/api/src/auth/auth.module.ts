import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { LeadIntakeGuard } from './guards';

@Global()
@Module({
  imports: [JwtModule.registerAsync({
    global: true, inject: [ConfigService],
    useFactory: (c: ConfigService) => ({ secret: c.getOrThrow('JWT_ACCESS_SECRET'), signOptions: { expiresIn: '15m' } }),
  })],
  controllers: [AuthController],
  providers: [AuthService, LeadIntakeGuard],
  exports: [AuthService, LeadIntakeGuard],
})
export class AuthModule {}
