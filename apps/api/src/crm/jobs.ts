import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import { subMinutes } from 'date-fns';
import { InventoryPort } from '../integrations/ports';
import { PrismaService } from '../prisma/prisma.module';
import { LeadStateMachineService } from './lead-state-machine.service';

@Injectable()
export class CrmJobs {
  private log = new Logger('CrmJobs');
  constructor(private prisma: PrismaService, private events: EventEmitter2, private inventory: InventoryPort, private sm: LeadStateMachineService) {}

  /** Every 5 min: NEW leads untouched past the SLA get flagged and escalated to the manager. */
  @Cron('*/5 * * * *')
  async checkSlaBreaches() {
    const setting = await this.prisma.systemSetting.findUnique({ where: { key: 'crm.sla.firstResponseMinutes' } });
    const minutes = typeof setting?.value === 'number' ? setting.value : 30;
    const stale = await this.prisma.lead.findMany({ where: { status: 'NEW', slaBreached: false, duplicateOfId: null, createdAt: { lt: subMinutes(new Date(), minutes) } } });
    for (const lead of stale) {
      const changed = await this.prisma.lead.updateMany({
        where: { id: lead.id, status: 'NEW', slaBreached: false },
        data: { slaBreached: true, version: { increment: 1 } },
      });
      if (!changed.count) continue;
      this.events.emit('lead.sla_breached', { leadId: lead.id, assignedTo: lead.assignedTo });
    }
    if (stale.length) this.log.warn(`${stale.length} SLA breach(es) flagged`);
  }

  /** Hourly: release units whose 48h hold lapsed. Only NEGOTIATION deals are ever swept — never a token-received one. */
  @Cron('0 * * * *')
  async releaseExpiredHolds() {
    const now = new Date();
    const expired = await this.prisma.deal.findMany({
      where: { stage: 'NEGOTIATION', holdExpiresAt: { lt: now } },
    });
    for (const deal of expired) {
      const result = await this.prisma.$transaction(async (tx) => {
        const changed = await tx.deal.updateMany({
          where: { id: deal.id, stage: 'NEGOTIATION', holdExpiresAt: { lt: now } },
          data: { stage: 'CANCELLED', lostReason: 'hold_expired' },
        });
        if (!changed.count) return { released: false, leadStatusChanged: false };
        await this.inventory.releaseUnit(tx, deal.unitId);
        const lead = await tx.lead.findUniqueOrThrow({ where: { id: deal.leadId } });
        const leadStatusChanged = lead.status === 'NEGOTIATION';
        if (leadStatusChanged) await this.sm.transition(tx, deal.leadId, 'QUALIFIED', 'system', { notes: 'Unit hold expired' });
        return { released: true, leadStatusChanged };
      });
      if (result.released) {
        if (result.leadStatusChanged) this.events.emit('lead.status_changed', { leadId: deal.leadId, from: 'NEGOTIATION', to: 'QUALIFIED' });
        this.events.emit('deal.expired', { dealId: deal.id });
      }
    }
  }
}
