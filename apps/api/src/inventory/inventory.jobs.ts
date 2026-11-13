import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.module';

@Injectable()
export class InventoryJobs {
  private readonly logger = new Logger(InventoryJobs.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_8AM)
  async checkReraCompliance() {
    const projects = await this.prisma.project.findMany({
      where: { status: { in: ['ACTIVE', 'UPCOMING'] } },
    });
    const now = Date.now();

    for (const project of projects) {
      const daysLeft = Math.ceil((project.reraValidTill.getTime() - now) / (1000 * 60 * 60 * 24));
      if (daysLeft <= 0) {
        this.logger.error(`RERA expired for project ${project.name} (${project.reraId})`);
        if (project.status === 'ACTIVE') {
          await this.prisma.project.update({ where: { id: project.id }, data: { status: 'ON_HOLD' } });
          this.events.emit('project.status_changed', {
            projectId: project.id,
            oldStatus: 'ACTIVE',
            newStatus: 'ON_HOLD',
            reason: 'RERA_EXPIRED_ESCALATION',
          });
        }
        this.events.emit('whatsapp.send_alert', {
          template: 'rera_expired_escalation',
          projectId: project.id,
          projectName: project.name,
          reraNumber: project.reraId,
          daysLeft,
        });
        continue;
      }

      const alertBuckets = [
        { days: 90, field: 'reraAlert90Sent' as const },
        { days: 30, field: 'reraAlert30Sent' as const },
        { days: 7, field: 'reraAlert7Sent' as const },
      ];
      for (const bucket of alertBuckets) {
        if (daysLeft <= bucket.days && !project[bucket.field]) {
          await this.prisma.project.update({ where: { id: project.id }, data: { [bucket.field]: true } });
          this.logger.warn(`RERA expiring within ${bucket.days} days for project ${project.name}`);
          this.events.emit('whatsapp.send_alert', {
            template: 'rera_expiry_alert',
            thresholdDays: bucket.days,
            projectId: project.id,
            projectName: project.name,
            reraNumber: project.reraId,
          });
        }
      }
    }
  }
}
