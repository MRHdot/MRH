import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.module';

@Injectable()
export class InventoryJobs {
  private readonly logger = new Logger(InventoryJobs.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_DAY_AT_6AM)
  async checkReraCompliance() {
    const projects = await this.prisma.project.findMany({
      where: { status: { in: ['ACTIVE', 'UPCOMING'] } },
    });

    for (const project of projects) {
      const daysLeft = Math.ceil((project.reraValidTill.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
      if (daysLeft <= 7 && !project.reraAlert7Sent) {
        this.logger.warn(`Project ${project.name} is approaching RERA expiry in ${daysLeft} days`);
        await this.prisma.project.update({ where: { id: project.id }, data: { reraAlert7Sent: true } });
      }
    }
  }
}
