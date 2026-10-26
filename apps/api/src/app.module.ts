import { Controller, Get, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthModule } from './auth/auth.module';
import { Public } from './auth/auth.types';
import { JwtAuthGuard, PermissionsGuard } from './auth/guards';
import { CrmModule } from './crm/crm.module';
import { IntegrationsModule } from './integrations/ports';
import { PrismaModule } from './prisma/prisma.module';

@Controller('health')
class HealthController { @Public() @Get() ok() { return { status: 'ok', ts: new Date().toISOString() }; } }

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }), EventEmitterModule.forRoot(), ScheduleModule.forRoot(),
    PrismaModule, AuthModule, IntegrationsModule, CrmModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },       // order matters: authenticate, then authorise
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}
