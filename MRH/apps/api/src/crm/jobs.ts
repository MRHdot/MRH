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
      await this.prisma.lead.update({ where: { id: lead.id }, data: { slaBreached: true } });
      this.events.emit('lead.sla_breached', { leadId: lead.id, assignedTo: lead.assignedTo });
    }
    if (stale.length) this.log.warn(`${stale.length} SLA breach(es) flagged`);
  }

  /** Hourly: release units whose 48h hold lapsed. Only NEGOTIATION deals are ever swept — never a token-received one. */
  @Cron('0 * * * *')
  async releaseExpiredHolds() {
    const expired = await this.prisma.deal.findMany({ where: { stage: 'NEGOTIATION', holdExpiresAt: { lt: new Date() } } });
    for (const deal of expired) {
      await this.prisma.$transaction(async (tx) => {
        await this.inventory.releaseUnit(tx, deal.unitId);
        await tx.deal.update({ where: { id: deal.id }, data: { stage: 'CANCELLED', lostReason: 'hold_expired' } });
        await this.sm.transition(tx, deal.leadId, 'QUALIFIED', 'system', { notes: 'Unit hold expired' });
      });
      this.events.emit('deal.expired', { dealId: deal.id });
    }
  }
}
