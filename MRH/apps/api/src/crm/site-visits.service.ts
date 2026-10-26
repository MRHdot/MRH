import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { addMinutes, subMinutes } from 'date-fns';
import { AuthUser } from '../auth/auth.types';
import { AppError } from '../common/errors';
import { PrismaService, Tx } from '../prisma/prisma.module';
import { CreateVisitDto, UpdateVisitDto } from './dto';
import { LeadStateMachineService } from './lead-state-machine.service';
import { LeadsService } from './leads.service';

const BUFFER_MINS = 30;   // travel buffer each side

@Injectable()
export class SiteVisitsService {
  constructor(private prisma: PrismaService, private events: EventEmitter2, private sm: LeadStateMachineService, private leads: LeadsService) {}

  private async conflicts(agentId: string, start: Date, mins: number, excludeId?: string) {
    const end = addMinutes(start, mins);
    const near = await this.prisma.siteVisit.findMany({
      where: { agentId, status: 'SCHEDULED', ...(excludeId ? { id: { not: excludeId } } : {}),
        scheduledAt: { gte: addMinutes(start, -24 * 60), lte: addMinutes(start, 72 * 60) } },
    });
    const clash = (s: Date, e: Date) => near.some((v) =>
      s < addMinutes(v.scheduledAt, v.durationMins + BUFFER_MINS) && e > subMinutes(v.scheduledAt, BUFFER_MINS));
    return { clashes: clash(start, end), clash };
  }

  private async assertFree(agentId: string, start: Date, mins: number, excludeId?: string) {
    const { clashes, clash } = await this.conflicts(agentId, start, mins, excludeId);
    if (!clashes) return;
    const suggestedSlots: string[] = [];
    for (let i = 1; i <= 96 && suggestedSlots.length < 3; i++) {
      const s = addMinutes(start, i * 30);
      if (!clash(s, addMinutes(s, mins))) suggestedSlots.push(s.toISOString());
    }
    throw new AppError(409, 'AGENT_DOUBLE_BOOKED', 'Agent already has a visit scheduled in this window', { suggestedSlots });
  }

  async create(dto: CreateVisitDto, user: AuthUser) {
    const lead = await this.leads.getScoped(dto.leadId, user);
    if (!lead.assignedTo) throw new AppError(422, 'GUARD_FAILED', 'Lead must be assigned before scheduling a visit');
    if (!['QUALIFIED', 'SITE_VISIT_SCHEDULED'].includes(lead.status)) {
      throw new AppError(422, 'ILLEGAL_TRANSITION', `Visits can only be scheduled for QUALIFIED leads (lead is ${lead.status})`);
    }
    const when = new Date(dto.scheduledAt);
    if (when <= new Date()) throw new AppError(400, 'VALIDATION_ERROR', 'scheduledAt must be in the future');
    const mins = dto.durationMins ?? 45;
    await this.assertFree(lead.assignedTo, when, mins);

    const visit = await this.prisma.$transaction(async (tx) => {
      const v = await tx.siteVisit.create({ data: { leadId: lead.id, unitId: dto.unitId, scheduledAt: when, durationMins: mins, agentId: lead.assignedTo! } });
      if (lead.status === 'QUALIFIED') await this.sm.transition(tx, lead.id, 'SITE_VISIT_SCHEDULED', user.id);
      await tx.leadActivity.create({ data: { leadId: lead.id, type: 'SITE_VISIT', createdBy: user.id, metadata: { siteVisitId: v.id, status: 'SCHEDULED' } } });
      return v;
    });
    this.events.emit('site_visit.scheduled', { siteVisitId: visit.id, leadId: lead.id });
    return visit;
  }

  list(q: { agentId?: string; status?: string; dateFrom?: string; dateTo?: string }, user: AuthUser) {
    return this.prisma.siteVisit.findMany({
      where: {
        ...(q.agentId ? { agentId: q.agentId } : {}), ...(q.status ? { status: q.status as any } : {}),
        ...(user.role === 'sales_agent' ? { agentId: user.id } : {}),
        ...(q.dateFrom || q.dateTo ? { scheduledAt: { ...(q.dateFrom ? { gte: new Date(q.dateFrom) } : {}), ...(q.dateTo ? { lte: new Date(q.dateTo) } : {}) } } : {}),
      },
      orderBy: { scheduledAt: 'asc' }, take: 200,
    });
  }

  async update(id: string, dto: UpdateVisitDto, user: AuthUser) {
    const visit = await this.prisma.siteVisit.findUnique({ where: { id } });
    if (!visit) throw new AppError(404, 'NOT_FOUND', 'Site visit not found');
    await this.leads.getScoped(visit.leadId, user);           // 404 if out of scope
    if (visit.status !== 'SCHEDULED') throw new AppError(409, 'CONFLICT', `Visit is already ${visit.status}`);

    // reschedule (reminder jobs are re-created here once the BullMQ reminder queue lands)
    if (dto.scheduledAt && !dto.status) {
      const when = new Date(dto.scheduledAt);
      if (when <= new Date()) throw new AppError(400, 'VALIDATION_ERROR', 'scheduledAt must be in the future');
      await this.assertFree(visit.agentId, when, visit.durationMins, id);
      return this.prisma.$transaction(async (tx) => {
        const v = await tx.siteVisit.update({ where: { id }, data: { scheduledAt: when } });
        await tx.leadActivity.create({ data: { leadId: visit.leadId, type: 'SITE_VISIT', createdBy: user.id, metadata: { siteVisitId: id, status: 'RESCHEDULED', from: visit.scheduledAt, to: when } } });
        return v;
      });
    }
    if (!dto.status || dto.status === 'SCHEDULED' || dto.status === 'RESCHEDULED') throw new AppError(400, 'VALIDATION_ERROR', 'Provide scheduledAt to reschedule, or a terminal status (COMPLETED / NO_SHOW / CANCELLED)');
    if (dto.status === 'COMPLETED' && !dto.outcome) throw new AppError(400, 'VALIDATION_ERROR', 'outcome is required when completing a visit');

    const updated = await this.prisma.$transaction(async (tx) => {
      const v = await tx.siteVisit.update({ where: { id }, data: { status: dto.status, outcome: dto.outcome, feedback: dto.feedback } });
      await tx.leadActivity.create({ data: { leadId: visit.leadId, type: 'SITE_VISIT', notes: dto.feedback, createdBy: user.id, metadata: { siteVisitId: id, status: dto.status, outcome: dto.outcome } } });
      await this.advanceLead(tx, visit.leadId, dto.status === 'COMPLETED' && dto.outcome === 'INTERESTED', user.id);
      return v;
    });
    if (dto.status === 'COMPLETED') this.events.emit('site_visit.completed', { siteVisitId: id, leadId: visit.leadId, outcome: dto.outcome });
    return updated;
  }

  /** INTERESTED → NEGOTIATION; anything else returns the lead to QUALIFIED unless another visit is still pending. */
  private async advanceLead(tx: Tx, leadId: string, interested: boolean, actorId: string) {
    const lead = await tx.lead.findUniqueOrThrow({ where: { id: leadId } });
    if (lead.status !== 'SITE_VISIT_SCHEDULED') return;
    if (interested) { await this.sm.transition(tx, leadId, 'NEGOTIATION', actorId); return; }
    const pending = await tx.siteVisit.count({ where: { leadId, status: 'SCHEDULED' } });
    if (pending === 0) await this.sm.transition(tx, leadId, 'QUALIFIED', actorId);
  }
}
