import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.module';
import { RevalidationService } from './revalidation.service';

@Injectable()
export class CmsListeners implements OnModuleDestroy {
  private readonly logger = new Logger(CmsListeners.name);
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private prisma: PrismaService, private revalidation: RevalidationService) {}

  @OnEvent('unit.created')
  @OnEvent('unit.price_changed')
  @OnEvent('unit.status_changed')
  unitChanged(event: { projectId: string; projectSlug?: string }) {
    if (!event.projectSlug) {
      this.logger.warn(`Inventory event for ${event.projectId} omitted projectSlug; skipped page revalidation`);
      return;
    }
    const prior = this.pending.get(event.projectId);
    if (prior) clearTimeout(prior);
    this.pending.set(event.projectId, setTimeout(() => {
      this.pending.delete(event.projectId);
      void this.revalidation.revalidate(`/projects/${event.projectSlug}`);
    }, 5000));
  }

  @OnEvent('project.status_changed')
  async projectStatusChanged(event: { projectId: string; newStatus: string; projectSlug?: string }) {
    if (event.newStatus === 'SOLD_OUT' || event.newStatus === 'ON_HOLD') {
      await this.prisma.projectSeoOverride.upsert({
        where: { projectId: event.projectId }, update: { noindex: true }, create: { projectId: event.projectId, noindex: true },
      });
    } else if (event.newStatus === 'ACTIVE') {
      await this.prisma.projectSeoOverride.updateMany({ where: { projectId: event.projectId }, data: { noindex: false } });
    }
    if (event.projectSlug) await this.revalidation.revalidate(`/projects/${event.projectSlug}`);
    await this.revalidation.revalidate('/sitemap.xml');
  }

  onModuleDestroy() {
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }
}