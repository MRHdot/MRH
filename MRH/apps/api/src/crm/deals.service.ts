import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DealStage, Prisma } from '@prisma/client';
import { addHours, max } from 'date-fns';
import { randomUUID } from 'crypto';
import { AuthUser } from '../auth/auth.types';
import { AppError } from '../common/errors';
import { InventoryPort, InvoiceLockPort } from '../integrations/ports';
import { PrismaService } from '../prisma/prisma.module';
import { CreateDealDto, DealStageDto, UpdateDealDto } from './dto';
import { LeadStateMachineService } from './lead-state-machine.service';
import { LeadsService } from './leads.service';
import { LOST_REASONS } from './lead-transitions';

const NEXT: Partial<Record<DealStage, DealStage>> = { NEGOTIATION: 'DOCUMENTATION', DOCUMENTATION: 'TOKEN_RECEIVED', TOKEN_RECEIVED: 'BOOKED' };
const ACTIVE: DealStage[] = ['NEGOTIATION', 'DOCUMENTATION', 'TOKEN_RECEIVED'];

@Injectable()
export class DealsService {
  constructor(
    private prisma: PrismaService, private events: EventEmitter2, private sm: LeadStateMachineService,
    private leads: LeadsService, private inventory: InventoryPort, private invoices: InvoiceLockPort,
  ) {}

  /** Lock the unit and create the deal atomically (one transaction). Lead must be in NEGOTIATION. */
  async create(dto: CreateDealDto, user: AuthUser) {
    const lead = await this.leads.getScoped(dto.leadId, user);
    if (lead.status !== 'NEGOTIATION') throw new AppError(422, 'ILLEGAL_TRANSITION', `A deal needs a lead in NEGOTIATION (lead is ${lead.status}); complete an INTERESTED site visit first`);

    const taken = await this.prisma.deal.findFirst({ where: { unitId: dto.unitId, stage: { in: ACTIVE }, NOT: { leadId: lead.id } } });
    if (taken) throw new AppError(409, 'UNIT_UNAVAILABLE', 'Unit is already held by another deal');

    const existing = await this.prisma.deal.findUnique({ where: { leadId: lead.id } });
    if (existing && existing.stage !== 'CANCELLED') throw new AppError(409, 'CONFLICT', 'Lead already has an active deal');
    const dealId = existing?.id ?? randomUUID();    // one deal per lead: a cancelled deal is re-pointed, not duplicated

    const deal = await this.prisma.$transaction(async (tx) => {
      const holdUntil = await this.inventory.holdUnitForDeal(tx, dto.unitId, dealId);
      const data = { unitId: dto.unitId, stage: 'NEGOTIATION' as DealStage, value: new Prisma.Decimal(dto.value), commissionPercent: new Prisma.Decimal(dto.commissionPercent), holdExpiresAt: holdUntil, lostReason: null, closedAt: null };
      const d = existing ? await tx.deal.update({ where: { id: dealId }, data }) : await tx.deal.create({ data: { id: dealId, leadId: lead.id, ...data } });
      await tx.leadActivity.create({ data: { leadId: lead.id, type: 'NOTE', createdBy: user.id, notes: `Deal opened on unit ${dto.unitId}; hold until ${holdUntil.toISOString()}` } });
      return d;
    });
    this.events.emit('deal.created', { dealId: deal.id, leadId: lead.id });
    return deal;
  }

  private async getScopedDeal(id: string, user: AuthUser) {
    const deal = await this.prisma.deal.findFirst({ where: { id, lead: user.role === 'sales_agent' ? { assignedTo: user.id } : {} }, include: { lead: true } });
    if (!deal) throw new AppError(404, 'NOT_FOUND', 'Deal not found');
    return deal;
  }
  get(id: string, user: AuthUser) { return this.getScopedDeal(id, user); }

  async updateStage(id: string, dto: DealStageDto, user: AuthUser) {
    const deal = await this.getScopedDeal(id, user);
    if (!ACTIVE.includes(deal.stage)) throw new AppError(409, 'CONFLICT', `Deal is already ${deal.stage}`);

    if (dto.stage === 'CANCELLED') {
      if (!dto.lostReason || !(LOST_REASONS as readonly string[]).includes(dto.lostReason)) throw new AppError(400, 'VALIDATION_ERROR', `lostReason required: ${LOST_REASONS.join(', ')}`);
    } else if (NEXT[deal.stage] !== dto.stage) {
      throw new AppError(422, 'ILLEGAL_TRANSITION', `Cannot go from ${deal.stage} to ${dto.stage}`, { legalNextStates: [NEXT[deal.stage], 'CANCELLED'].filter(Boolean) });
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const d = await tx.deal.update({
        where: { id },
        data: { stage: dto.stage, ...(dto.stage === 'CANCELLED' ? { lostReason: dto.lostReason } : {}), ...(dto.stage === 'BOOKED' ? { closedAt: new Date() } : {}) },
      });
      if (dto.stage === 'BOOKED') {
        await this.inventory.markUnitSold(tx, deal.unitId);
        await this.sm.transition(tx, deal.leadId, 'BOOKED', user.id);
      } else if (dto.stage === 'CANCELLED') {
        await this.inventory.releaseUnit(tx, deal.unitId);
        if (deal.lead.status === 'NEGOTIATION') await this.sm.transition(tx, deal.leadId, 'QUALIFIED', user.id, { notes: `Deal cancelled: ${dto.lostReason}` });
      }
      return d;
    });
    // events fire only after the transaction has committed
    if (dto.stage === 'BOOKED') { this.events.emit('lead.status_changed', { leadId: deal.leadId, from: 'NEGOTIATION', to: 'BOOKED' }); this.events.emit('deal.closed', { dealId: id }); }
    return updated;
  }

  async extendHold(id: string, hours: number, user: AuthUser) {
    const deal = await this.getScopedDeal(id, user);
    if (deal.stage !== 'NEGOTIATION') throw new AppError(409, 'CONFLICT', 'Only deals in NEGOTIATION have an expiring hold');
    const until = addHours(max([new Date(), deal.holdExpiresAt ?? new Date()]), hours);
    return this.prisma.$transaction(async (tx) => {
      await this.inventory.extendHold(tx, deal.unitId, until);
      await tx.leadActivity.create({ data: { leadId: deal.leadId, type: 'NOTE', createdBy: user.id, notes: `Hold extended by ${hours}h to ${until.toISOString()}` } });
      return tx.deal.update({ where: { id }, data: { holdExpiresAt: until } });
    });
  }

  async update(id: string, dto: UpdateDealDto, user: AuthUser) {
    const deal = await this.getScopedDeal(id, user);
    if (await this.invoices.hasActiveInvoice(id)) throw new AppError(423, 'LOCKED', 'Deal has an active invoice — void and reissue it in Finance first');
    return this.prisma.$transaction(async (tx) => {
      const d = await tx.deal.update({ where: { id }, data: { ...(dto.value != null ? { value: new Prisma.Decimal(dto.value) } : {}), ...(dto.commissionPercent != null ? { commissionPercent: new Prisma.Decimal(dto.commissionPercent) } : {}) } });
      await tx.auditLog.create({ data: { actorId: user.id, action: 'deal.updated', entityType: 'Deal', entityId: id, before: { value: deal.value.toString(), commissionPercent: deal.commissionPercent.toString() }, after: { value: d.value.toString(), commissionPercent: d.commissionPercent.toString() } } });
      return d;
    });
  }
}
