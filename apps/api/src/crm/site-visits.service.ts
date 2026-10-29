import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { LeadStatus } from '@prisma/client';
import { addDays, addMinutes, endOfDay, startOfDay, subMinutes } from 'date-fns';
import { AuthUser } from '../auth/auth.types';
import { AppError } from '../common/errors';
import { PrismaService, Tx } from '../prisma/prisma.module';
import { CreateVisitDto, ListVisitsQuery, UpdateVisitDto } from './dto';
import { LeadStateMachineService } from './lead-state-machine.service';
import { LeadsService, scopeFor } from './leads.service';
import { VisitReminderQueueService } from './visit-reminder-queue.service';

const BUFFER_MINS = 30;   // travel buffer each side

@Injectable()
export class SiteVisitsService {
  constructor(
    private prisma: PrismaService,
    private events: EventEmitter2,
    private sm: LeadStateMachineService,
    private leads: LeadsService,
    private reminders: VisitReminderQueueService,
  ) {}

  private async conflicts(agentId: string, start: Date, mins: number, excludeId?: string, tx: PrismaService | Tx = this.prisma) {
    const end = addMinutes(start, mins);
    const near = await tx.siteVisit.findMany({
      where: { agentId, status: 'SCHEDULED', ...(excludeId ? { id: { not: excludeId } } : {}),
        scheduledAt: { gte: addMinutes(start, -24 * 60), lte: addMinutes(start, 72 * 60) } },
    });
    const clash = (s: Date, e: Date) => near.some((v) =>
      s < addMinutes(v.scheduledAt, v.durationMins + BUFFER_MINS) && e > subMinutes(v.scheduledAt, BUFFER_MINS));
    return { clashes: clash(start, end), clash };
  }

  private async assertFree(agentId: string, start: Date, mins: number, excludeId?: string, tx: PrismaService | Tx = this.prisma) {
    const { clashes, clash } = await this.conflicts(agentId, start, mins, excludeId, tx);
    if (!clashes) return;
    const suggestedSlots: string[] = [];
    const lastStart = endOfDay(start);
    for (let i = 1; suggestedSlots.length < 3; i++) {
      const s = addMinutes(start, i * 30);
      if (s > lastStart || addMinutes(s, mins) > lastStart) break;
      if (!clash(s, addMinutes(s, mins))) suggestedSlots.push(s.toISOString());
    }
    throw new AppError(409, 'AGENT_DOUBLE_BOOKED', 'Agent already has a visit scheduled in this window', { suggestedSlots });
  }

  async create(dto: CreateVisitDto, user: AuthUser) {
    const lead = await this.leads.getScoped(dto.leadId, user);
    const when = new Date(dto.scheduledAt);
    if (when <= new Date()) throw new AppError(400, 'VALIDATION_ERROR', 'scheduledAt must be in the future');
    const mins = dto.durationMins ?? 45;
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Lead" WHERE "id" = ${lead.id} FOR UPDATE`;
      const currentLead = await tx.lead.findFirst({ where: { id: lead.id, ...scopeFor(user) } });
      if (!currentLead) throw new AppError(404, 'NOT_FOUND', 'Lead not found');
      if (!currentLead.assignedTo) throw new AppError(422, 'GUARD_FAILED', 'Lead must be assigned before scheduling a visit');
      if (!['QUALIFIED', 'SITE_VISIT_SCHEDULED'].includes(currentLead.status)) {
        throw new AppError(422, 'ILLEGAL_TRANSITION', `Visits can only be scheduled for QUALIFIED leads (lead is ${currentLead.status})`);
      }
      const agentId = currentLead.assignedTo;
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${agentId}))`;
      const lockedLead = await tx.lead.findFirst({ where: { id: lead.id, ...scopeFor(user) }, select: { assignedTo: true } });
      if (!lockedLead || lockedLead.assignedTo !== agentId) throw new AppError(409, 'CONFLICT', 'Lead assignment changed while scheduling; refresh and retry');
      await this.assertFree(agentId, when, mins, undefined, tx);
      const v = await tx.siteVisit.create({ data: { leadId: lead.id, unitId: dto.unitId, scheduledAt: when, durationMins: mins, agentId } });
      if (currentLead.status === 'QUALIFIED') await this.sm.transition(tx, lead.id, 'SITE_VISIT_SCHEDULED', user.id);
      await tx.leadActivity.create({ data: { leadId: lead.id, type: 'SITE_VISIT', createdBy: user.id, metadata: { siteVisitId: v.id, status: 'SCHEDULED' } } });
      return { visit: v, statusChanged: currentLead.status === 'QUALIFIED' };
    });
    if (result.statusChanged) this.events.emit('lead.status_changed', { leadId: lead.id, from: 'QUALIFIED', to: 'SITE_VISIT_SCHEDULED' });
    this.events.emit('site_visit.scheduled', { siteVisitId: result.visit.id, leadId: lead.id });
    const reminderJobId = await this.reminders.schedule(result.visit.id, result.visit.scheduledAt);
    return this.prisma.siteVisit.update({ where: { id: result.visit.id }, data: { reminderJobId } });
  }

  list(q: ListVisitsQuery, user: AuthUser) {
    if (q.date && (q.dateFrom || q.dateTo)) throw new AppError(400, 'VALIDATION_ERROR', 'Use date or dateFrom/dateTo, not both');
    const dateRange: { gte?: Date; lt?: Date; lte?: Date } | undefined = q.date
      ? { gte: startOfDay(new Date(q.date)), lt: addDays(startOfDay(new Date(q.date)), 1) }
      : q.dateFrom || q.dateTo
        ? { ...(q.dateFrom ? { gte: new Date(q.dateFrom) } : {}), ...(q.dateTo ? { lte: new Date(q.dateTo) } : {}) }
        : undefined;
    return this.prisma.siteVisit.findMany({
      where: {
        ...(q.agentId ? { agentId: q.agentId } : {}), ...(q.status ? { status: q.status } : {}),
        ...(user.role === 'sales_agent' ? { agentId: user.id } : {}),
        ...(dateRange ? { scheduledAt: dateRange } : {}),
      },
      orderBy: { scheduledAt: 'asc' }, take: 200,
    });
  }

  async update(id: string, dto: UpdateVisitDto, user: AuthUser) {
    const visit = await this.prisma.siteVisit.findUnique({ where: { id } });
    if (!visit) throw new AppError(404, 'NOT_FOUND', 'Site visit not found');
    await this.leads.getScoped(visit.leadId, user);           // 404 if out of scope
    if (visit.status !== 'SCHEDULED') throw new AppError(409, 'CONFLICT', `Visit is already ${visit.status}`);

    // Rescheduling invalidates the old delayed jobs before new reminders are scheduled.
    if (dto.scheduledAt && !dto.status) {
      const when = new Date(dto.scheduledAt);
      if (when <= new Date()) throw new AppError(400, 'VALIDATION_ERROR', 'scheduledAt must be in the future');
      const result = await this.prisma.$transaction(async (tx) => {
        const current = await this.scopedVisit(tx, id, user);
        if (current.status !== 'SCHEDULED') throw new AppError(409, 'CONFLICT', `Visit is already ${current.status}`);
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${current.agentId}))`;
        await this.assertFree(current.agentId, when, current.durationMins, id, tx);
        const v = await tx.siteVisit.update({ where: { id }, data: { scheduledAt: when } });
        await tx.leadActivity.create({ data: { leadId: current.leadId, type: 'SITE_VISIT', createdBy: user.id, metadata: { siteVisitId: id, status: 'RESCHEDULED', from: current.scheduledAt, to: when } } });
        return { visit: v, previous: current };
      });
      await this.reminders.cancel(id, result.previous.scheduledAt, result.previous.reminderJobId);
      const reminderJobId = await this.reminders.schedule(result.visit.id, result.visit.scheduledAt);
      return this.prisma.siteVisit.update({ where: { id }, data: { reminderJobId } });
    }
    if (!dto.status || dto.status === 'SCHEDULED' || dto.status === 'RESCHEDULED') throw new AppError(400, 'VALIDATION_ERROR', 'Provide scheduledAt to reschedule, or a terminal status (COMPLETED / NO_SHOW / CANCELLED)');
    if (dto.status === 'COMPLETED' && !dto.outcome) throw new AppError(400, 'VALIDATION_ERROR', 'outcome is required when completing a visit');
    const outcome = await this.prisma.$transaction(async (tx) => {
      const current = await this.scopedVisit(tx, id, user);
      if (current.status !== 'SCHEDULED') throw new AppError(409, 'CONFLICT', `Visit is already ${current.status}`);
      const v = await tx.siteVisit.update({ where: { id }, data: { status: dto.status, outcome: dto.outcome, feedback: dto.feedback } });
      await tx.leadActivity.create({ data: { leadId: current.leadId, type: 'SITE_VISIT', notes: dto.feedback, createdBy: user.id, metadata: { siteVisitId: id, status: dto.status, outcome: dto.outcome } } });
      const transition = await this.advanceLead(tx, current.leadId, dto.status === 'COMPLETED' && dto.outcome === 'INTERESTED', user.id);
      return { visit: v, transition, previous: current };
    });
    if (outcome.transition) this.events.emit('lead.status_changed', { leadId: outcome.previous.leadId, ...outcome.transition });
    if (dto.status === 'COMPLETED') this.events.emit('site_visit.completed', { siteVisitId: id, leadId: outcome.previous.leadId, outcome: dto.outcome });
    await this.reminders.cancel(id, outcome.previous.scheduledAt, outcome.previous.reminderJobId);
    return outcome.visit;
  }

  private async scopedVisit(tx: Tx, id: string, user: AuthUser) {
    const visit = await tx.siteVisit.findUnique({ where: { id } });
    if (!visit) throw new AppError(404, 'NOT_FOUND', 'Site visit not found');
    await tx.$queryRaw`SELECT "id" FROM "Lead" WHERE "id" = ${visit.leadId} FOR UPDATE`;
    const current = await tx.siteVisit.findFirst({ where: { id, lead: { is: scopeFor(user) } } });
    if (!current) throw new AppError(404, 'NOT_FOUND', 'Site visit not found');
    return current;
  }

  /** INTERESTED → NEGOTIATION; anything else returns the lead to QUALIFIED unless another visit is still pending. */
  private async advanceLead(tx: Tx, leadId: string, interested: boolean, actorId: string): Promise<{ from: LeadStatus; to: LeadStatus } | null> {
    const lead = await tx.lead.findUniqueOrThrow({ where: { id: leadId } });
    if (lead.status !== 'SITE_VISIT_SCHEDULED') return null;
    if (interested) {
      await this.sm.transition(tx, leadId, 'NEGOTIATION', actorId);
      return { from: 'SITE_VISIT_SCHEDULED', to: 'NEGOTIATION' };
    }
    const pending = await tx.siteVisit.count({ where: { leadId, status: 'SCHEDULED' } });
    if (pending === 0) {
      await this.sm.transition(tx, leadId, 'QUALIFIED', actorId);
      return { from: 'SITE_VISIT_SCHEDULED', to: 'QUALIFIED' };
    }
    return null;
  }
}
