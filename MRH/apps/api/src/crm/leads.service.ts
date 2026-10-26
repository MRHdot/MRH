import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { startOfDay, subDays } from 'date-fns';
import { AuthUser } from '../auth/auth.types';
import { AppError } from '../common/errors';
import { normalizePhone } from '../common/phone';
import { InventoryPort } from '../integrations/ports';
import { PrismaService } from '../prisma/prisma.module';
import { AssignmentService } from './assignment.service';
import { AssignDto, ChangeStatusDto, CreateActivityDto, CreateLeadDto, ListLeadsQuery, PipelineQuery, UpdateLeadDto } from './dto';
import { LeadStateMachineService } from './lead-state-machine.service';
import { legalNextStates, MANUALLY_REQUESTABLE } from './lead-transitions';

/** Row-level scoping: derived from the verified JWT, never from client input. */
export const scopeFor = (u: AuthUser): Prisma.LeadWhereInput => (u.role === 'sales_agent' ? { assignedTo: u.id } : {});
const SYSTEM_ONLY = ['STATUS_CHANGE', 'ASSIGNMENT_CHANGE', 'DUPLICATE_MERGE', 'SITE_VISIT'];
const DUP_WINDOW_DAYS = 30;

@Injectable()
export class LeadsService {
  constructor(
    private prisma: PrismaService, private events: EventEmitter2,
    private sm: LeadStateMachineService, private assignment: AssignmentService, private inventory: InventoryPort,
  ) {}

  // ───────── create + duplicate detection ─────────
  async createLead(dto: CreateLeadDto, actor: AuthUser, ip?: string) {
    if (dto.budgetMin != null && dto.budgetMax != null && dto.budgetMin > dto.budgetMax) {
      throw new AppError(400, 'VALIDATION_ERROR', 'budgetMin must be ≤ budgetMax');
    }
    if (dto.consentGiven && !dto.consentText?.trim()) {
      throw new AppError(400, 'VALIDATION_ERROR', 'consentText (verbatim wording shown) is required when consentGiven is true');
    }
    const phone = normalizePhone(dto.phone);
    const existing = await this.prisma.lead.findFirst({
      where: { phone, createdAt: { gte: subDays(new Date(), DUP_WINDOW_DAYS) }, duplicateOfId: null },
      orderBy: { createdAt: 'desc' },
    });

    if (existing) {
      await this.prisma.$transaction([
        this.prisma.leadActivity.create({
          data: { leadId: existing.id, type: 'DUPLICATE_MERGE', notes: `Duplicate enquiry via ${dto.source}`, metadata: { duplicateSource: dto.source }, createdBy: 'system' },
        }),
        this.prisma.lead.update({ where: { id: existing.id }, data: { updatedAt: new Date() } }), // bump to top of queue
      ]);
      this.events.emit('lead.duplicate_detected', { leadId: existing.id, source: dto.source });
      return { data: existing, meta: { wasDuplicate: true } };
    }

    const assignee = await this.assignment.findAssignee();
    const lead = await this.prisma.$transaction(async (tx) => {
      const l = await tx.lead.create({
        data: {
          name: dto.name, phone, email: dto.email, source: dto.source, projectInterest: dto.projectInterest,
          budgetMin: dto.budgetMin, budgetMax: dto.budgetMax, assignedTo: assignee,
        },
      });
      if (assignee) {
        await tx.leadActivity.create({
          data: { leadId: l.id, type: 'ASSIGNMENT_CHANGE', createdBy: 'system', metadata: { fromAgent: null, toAgent: assignee, reason: 'auto_load_balance' } },
        });
      }
      if (dto.consentGiven !== undefined) {
        await tx.consent.create({
          data: { contactPhone: phone, channel: 'WHATSAPP', given: dto.consentGiven, consentText: dto.consentText ?? '(declined)', ipAddress: ip },
        });
      }
      return l;
    });
    this.events.emit('lead.created', { leadId: lead.id, phone });            // after commit
    if (assignee) this.events.emit('lead.assigned', { leadId: lead.id, agentId: assignee });
    else this.events.emit('lead.unassigned', { leadId: lead.id });
    return { data: lead, meta: { wasDuplicate: false } };
  }

  // ───────── reads ─────────
  async list(q: ListLeadsQuery, user: AuthUser) {
    const limit = q.limit ?? 25;
    const where: Prisma.LeadWhereInput = {
      duplicateOfId: null,
      ...(q.status ? { status: { in: q.status.split(',') as any } } : {}),
      ...(q.source ? { source: q.source } : {}),
      ...(q.slaBreached ? { slaBreached: q.slaBreached === 'true' } : {}),
      ...(q.assignedTo ? { assignedTo: q.assignedTo } : {}),
      ...scopeFor(user),                           // spread last: an agent can never override their own scope
    };
    const rows = await this.prisma.lead.findMany({
      where, take: limit + 1, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return { data: items, meta: { nextCursor: hasMore ? items[items.length - 1].id : null } };
  }

  /** Out-of-scope and non-existent both → 404 (never confirm a lead exists to an unauthorised caller). */
  async getScoped(id: string, user: AuthUser) {
    const lead = await this.prisma.lead.findFirst({ where: { id, ...scopeFor(user) } });
    if (!lead) throw new AppError(404, 'NOT_FOUND', 'Lead not found');
    return lead;
  }

  async getDetail(id: string, user: AuthUser) {
    await this.getScoped(id, user);
    return this.prisma.lead.findUniqueOrThrow({
      where: { id },
      include: { activities: { orderBy: { createdAt: 'desc' }, take: 20 }, siteVisits: { orderBy: { scheduledAt: 'desc' } }, deal: true },
    });
  }

  async listActivities(id: string, user: AuthUser, type?: string, cursor?: string, limit = 25) {
    await this.getScoped(id, user);
    const rows = await this.prisma.leadActivity.findMany({
      where: { leadId: id, ...(type ? { type: type as any } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return { data: items, meta: { nextCursor: hasMore ? items[items.length - 1].id : null } };
  }

  async pipeline(q: PipelineQuery, user: AuthUser) {
    const rows = await this.prisma.lead.findMany({
      where: {
        duplicateOfId: null, status: { not: 'LOST' },
        ...(q.projectInterest ? { projectInterest: { contains: q.projectInterest, mode: 'insensitive' } } : {}),
        ...(q.dateFrom || q.dateTo ? { createdAt: { ...(q.dateFrom ? { gte: new Date(q.dateFrom) } : {}), ...(q.dateTo ? { lte: new Date(q.dateTo) } : {}) } } : {}),
        ...(q.agentId ? { assignedTo: q.agentId } : {}),
        ...scopeFor(user),
      },
      select: { id: true, name: true, status: true, assignedTo: true, source: true, slaBreached: true, createdAt: true },
      orderBy: { createdAt: 'desc' }, take: 1000,
    });
    const board: Record<string, typeof rows> = { NEW: [], CONTACTED: [], QUALIFIED: [], SITE_VISIT_SCHEDULED: [], NEGOTIATION: [], BOOKED: [] };
    for (const r of rows) board[r.status].push(r);
    return board;
  }

  // ───────── edits ─────────
  /** Optimistic locking: caller must send the version it read (If-Match). */
  async update(id: string, dto: UpdateLeadDto, version: number, user: AuthUser) {
    const lead = await this.getScoped(id, user);
    const min = dto.budgetMin ?? lead.budgetMin; const max = dto.budgetMax ?? lead.budgetMax;
    if (min != null && max != null && min > max) throw new AppError(400, 'VALIDATION_ERROR', 'budgetMin must be ≤ budgetMax');
    const res = await this.prisma.lead.updateMany({ where: { id, version }, data: { ...dto, version: { increment: 1 } } });
    if (res.count === 0) throw new AppError(409, 'CONFLICT', 'Lead was modified by someone else — refresh and retry', { currentVersion: lead.version });
    return this.prisma.lead.findUniqueOrThrow({ where: { id } });
  }

  async changeStatus(id: string, dto: ChangeStatusDto, user: AuthUser) {
    const lead = await this.getScoped(id, user);
    if (!MANUALLY_REQUESTABLE.includes(dto.status)) {
      throw new AppError(422, 'ILLEGAL_TRANSITION', `${dto.status} is set automatically by site visits / deals, not directly`, { legalNextStates: legalNextStates(lead.status) });
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const l = await this.sm.transition(tx, id, dto.status, user.id, { lostReason: dto.lostReason, notes: dto.notes });
      if (dto.status === 'LOST') await this.cancelOpenDeal(tx, id, user.id, 'LEAD_LOST');
      return l;
    });
    this.events.emit('lead.status_changed', { leadId: id, from: lead.status, to: dto.status });
    return updated;
  }

  async reactivate(id: string, notes: string | undefined, user: AuthUser) {
    const lead = await this.getScoped(id, user);
    if (lead.status !== 'LOST') throw new AppError(422, 'ILLEGAL_TRANSITION', 'Only LOST leads can be reactivated');
    const updated = await this.prisma.$transaction((tx) => this.sm.transition(tx, id, 'CONTACTED', user.id, { reactivate: true, notes }));
    this.events.emit('lead.status_changed', { leadId: id, from: 'LOST', to: 'CONTACTED' });
    return updated;
  }

  async assign(id: string, dto: AssignDto, user: AuthUser) {
    const lead = await this.prisma.lead.findUnique({ where: { id } });
    if (!lead) throw new AppError(404, 'NOT_FOUND', 'Lead not found');
    const agent = await this.prisma.user.findFirst({ where: { id: dto.agentId, status: 'ACTIVE', role: { name: { in: ['sales_agent', 'sales_manager'] } } } });
    if (!agent) throw new AppError(400, 'VALIDATION_ERROR', 'agentId must be an active sales agent/manager');
    const updated = await this.prisma.$transaction(async (tx) => {
      const l = await tx.lead.update({ where: { id }, data: { assignedTo: agent.id, version: { increment: 1 } } });
      await tx.leadActivity.create({
        data: { leadId: id, type: 'ASSIGNMENT_CHANGE', createdBy: user.id, metadata: { fromAgent: lead.assignedTo, toAgent: agent.id, reason: 'manual_reassignment' } },
      });
      await tx.auditLog.create({ data: { actorId: user.id, action: 'lead.assigned', entityType: 'Lead', entityId: id, before: { assignedTo: lead.assignedTo }, after: { assignedTo: agent.id } } });
      return l;
    });
    this.events.emit('lead.assigned', { leadId: id, agentId: agent.id });
    return updated;
  }

  /** Only for accidental empty entries; anything with real history is never hard-deleted. */
  async remove(id: string, user: AuthUser) {
    const lead = await this.getScoped(id, user);
    const [activities, visits, deal] = await Promise.all([
      this.prisma.leadActivity.count({ where: { leadId: id, type: { not: 'ASSIGNMENT_CHANGE' } } }),
      this.prisma.siteVisit.count({ where: { leadId: id } }),
      this.prisma.deal.count({ where: { leadId: id } }),
    ]);
    if (activities || visits || deal) throw new AppError(409, 'CONFLICT', 'Lead has history and cannot be deleted (use the DPDP erasure workflow)');
    if (user.role === 'sales_agent' && lead.createdAt < startOfDay(new Date())) throw new AppError(403, 'FORBIDDEN', 'Agents may only delete leads created today');
    await this.prisma.$transaction([
      this.prisma.leadActivity.deleteMany({ where: { leadId: id } }),   // only ASSIGNMENT_CHANGE rows can remain here
      this.prisma.lead.delete({ where: { id } }),
    ]);
    return { deleted: true };
  }

  // ───────── activities ─────────
  async addActivity(id: string, dto: CreateActivityDto, user: AuthUser) {
    const lead = await this.getScoped(id, user);
    if (SYSTEM_ONLY.includes(dto.type)) throw new AppError(400, 'VALIDATION_ERROR', `${dto.type} activities are written by the system only`);
    const act = await this.prisma.$transaction(async (tx) => {
      const a = await tx.leadActivity.create({ data: { leadId: id, type: dto.type, notes: dto.notes, metadata: dto.metadata as any, createdBy: user.id } });
      // first touch stops the SLA clock: NEW → CONTACTED as a side effect
      if (lead.status === 'NEW' && lead.assignedTo && ['CALL', 'WHATSAPP', 'NOTE'].includes(dto.type)) {
        await this.sm.transition(tx, id, 'CONTACTED', user.id);
      }
      return a;
    });
    if (lead.status === 'NEW' && lead.assignedTo && ['CALL', 'WHATSAPP', 'NOTE'].includes(dto.type)) {
      this.events.emit('lead.status_changed', { leadId: id, from: 'NEW', to: 'CONTACTED' });
    }
    return act;
  }

  /** Used by LOST: cancel the open deal + release its unit in the same transaction. */
  private async cancelOpenDeal(tx: Prisma.TransactionClient, leadId: string, actorId: string, reason: string) {
    const deal = await tx.deal.findUnique({ where: { leadId } });
    if (deal && !['BOOKED', 'CANCELLED'].includes(deal.stage)) {
      await tx.deal.update({ where: { id: deal.id }, data: { stage: 'CANCELLED', lostReason: reason } });
      await this.inventory.releaseUnit(tx, deal.unitId);
      await tx.leadActivity.create({ data: { leadId, type: 'NOTE', notes: 'Deal cancelled because the lead was marked LOST', createdBy: actorId } });
    }
  }
}
