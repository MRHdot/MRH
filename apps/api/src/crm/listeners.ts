import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { WhatsappPort } from '../integrations/ports';
import { PrismaService } from '../prisma/prisma.module';

/** WhatsApp side-effects. Go through WhatsappPort: stubbed now, real Module 04 later. */
@Injectable()
export class CrmListeners {
  constructor(private wa: WhatsappPort, private prisma: PrismaService) {}

  @OnEvent('lead.created')
  async ack({ leadId, phone }: { leadId: string; phone: string }) {
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead) return;
    const consent = await this.prisma.consent.findFirst({
      where: { contactPhone: phone, channel: 'WHATSAPP' },
      orderBy: { createdAt: 'desc' },
      select: { given: true },
    });
    if (consent?.given) await this.wa.sendTemplate(phone, 'lead_acknowledgement', [lead.name]);
  }
  @OnEvent('lead.assigned')
  async assigned({ leadId, agentId }: { leadId: string; agentId: string }) { await this.wa.notifyUser(agentId, `New lead assigned: ${leadId}`); }
  @OnEvent('lead.unassigned')
  async unassigned({ leadId }: { leadId: string }) { await this.wa.notifyRole('sales_manager', `No eligible agent for lead ${leadId} — assign manually`); }
  @OnEvent('lead.sla_breached')
  async sla({ leadId }: { leadId: string }) { await this.wa.notifyRole('sales_manager', `SLA breached for lead ${leadId}`); }
  @OnEvent('deal.expired')
  async expired({ dealId }: { dealId: string }) {
    const d = await this.prisma.deal.findUnique({ where: { id: dealId }, include: { lead: true } });
    if (d?.lead.assignedTo) await this.wa.notifyUser(d.lead.assignedTo, `Unit hold lapsed for deal ${dealId}`);
  }
}
