import { HttpException, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { LeadStatus, Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { startOfDay, startOfMonth, startOfQuarter, startOfWeek, subDays } from 'date-fns';
import { validate } from 'class-validator';
import { AuthUser } from '../auth/auth.types';
import { AppError } from '../common/errors';
import { normalizePhone } from '../common/phone';
import { InventoryPort } from '../integrations/ports';
import { PrismaService, Tx } from '../prisma/prisma.module';
import { AssignmentService } from './assignment.service';
import { AssignDto, BulkReassignDto, ChangeStatusDto, CreateActivityDto, CreateLeadDto, LeaderboardQuery, ListActivitiesQuery, ListLeadsQuery, PipelineQuery, UpdateLeadDto } from './dto';
import { parseCsv, toCsv } from './csv';
import { LeadStateMachineService } from './lead-state-machine.service';
import { legalNextStates, MANUALLY_REQUESTABLE } from './lead-transitions';

/** Row-level scoping: derived from the verified JWT, never from client input. */
export const scopeFor = (u: AuthUser): Prisma.LeadWhereInput => {
  if (u.role === 'sales_agent') return { assignedTo: u.id };
  if (u.role === 'channel_partner') return { referredBy: u.id };
  return {};
};
const SYSTEM_ONLY = ['STATUS_CHANGE', 'ASSIGNMENT_CHANGE', 'DUPLICATE_MERGE', 'SITE_VISIT'];
const DUP_WINDOW_DAYS = 30;
const MAX_IMPORT_ROWS = 5_000;

@Injectable()
export class LeadsService {
  constructor(
    private prisma: PrismaService, private events: EventEmitter2,
    private sm: LeadStateMachineService, private assignment: AssignmentService, private inventory: InventoryPort,
  ) {}

  // ───────── create + duplicate detection ─────────
  async createLead(dto: CreateLeadDto, actor: AuthUser, ip?: string) {
    const source = actor.role === 'channel_partner' ? 'CHANNEL_PARTNER' : dto.source;
    if (dto.budgetMin != null && dto.budgetMax != null && dto.budgetMin > dto.budgetMax) {
      throw new AppError(400, 'VALIDATION_ERROR', 'budgetMin must be ≤ budgetMax');
    }
    if (dto.consentGiven && !dto.consentText?.trim()) {
      throw new AppError(400, 'VALIDATION_ERROR', 'consentText (verbatim wording shown) is required when consentGiven is true');
    }
    const phone = normalizePhone(dto.phone);
    const assignee = await this.assignment.findAssignee(dto.projectInterest);
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${phone}))`;
      const existing = await tx.lead.findFirst({
        where: { phone, createdAt: { gte: subDays(new Date(), DUP_WINDOW_DAYS) }, duplicateOfId: null },
        orderBy: { createdAt: 'desc' },
      });
      if (existing) {
        await tx.leadActivity.create({
          data: { leadId: existing.id, type: 'DUPLICATE_MERGE', notes: `Duplicate enquiry via ${source}`, metadata: { duplicateSource: source }, createdBy: 'system' },
        });
        const mergedLead = await tx.lead.update({
          where: { id: existing.id },
          data: { updatedAt: new Date(), version: { increment: 1 } },
        });
        await tx.consent.create({
          data: { contactPhone: phone, channel: 'WHATSAPP', given: dto.consentGiven === true, consentText: dto.consentText ?? 'Consent not recorded at lead intake', ipAddress: ip },
        });
        return { lead: mergedLead, wasDuplicate: true };
      }

      const lead = await tx.lead.create({
        data: {
          name: dto.name, phone, email: dto.email, source, projectInterest: dto.projectInterest,
          budgetMin: dto.budgetMin, budgetMax: dto.budgetMax, assignedTo: assignee,
          ...(actor.role === 'channel_partner' ? { referredBy: actor.id } : {}),
        },
      });
      if (assignee) {
        await tx.leadActivity.create({
          data: { leadId: lead.id, type: 'ASSIGNMENT_CHANGE', createdBy: 'system', metadata: { fromAgent: null, toAgent: assignee, reason: 'auto_load_balance' } },
        });
      }
      await tx.consent.create({
        data: { contactPhone: phone, channel: 'WHATSAPP', given: dto.consentGiven === true, consentText: dto.consentText ?? 'Consent not recorded at lead intake', ipAddress: ip },
      });
      return { lead, wasDuplicate: false };
    });

    if (result.wasDuplicate) {
      const { lead } = result;
      this.events.emit('lead.duplicate_detected', { leadId: lead.id, source });
      if (actor.role === 'channel_partner' && lead.referredBy !== actor.id) {
        return { data: { accepted: true }, meta: { wasDuplicate: true } };
      }
      return { data: lead, meta: { wasDuplicate: true } };
    }

    const { lead } = result;
    this.events.emit('lead.created', { leadId: lead.id, phone });            // after commit
    if (assignee) this.events.emit('lead.assigned', { leadId: lead.id, agentId: assignee });
    else this.events.emit('lead.unassigned', { leadId: lead.id });
    return { data: lead, meta: { wasDuplicate: false } };
  }

  async bulkImport(file: Buffer, actor: AuthUser, ip?: string) {
    let rows: string[][];
    try {
      rows = parseCsv(file.toString('utf8'));
    } catch (error) {
      throw new AppError(400, 'VALIDATION_ERROR', error instanceof Error ? error.message : 'Invalid CSV');
    }
    if (rows.length < 2) throw new AppError(400, 'VALIDATION_ERROR', 'CSV must contain a header and at least one lead row');
    if (rows.length - 1 > MAX_IMPORT_ROWS) throw new AppError(400, 'VALIDATION_ERROR', `CSV may contain at most ${MAX_IMPORT_ROWS} lead rows`);

    const headers = rows[0].map((header) => header.trim().toLowerCase());
    const missing = ['name', 'phone', 'source'].filter((header) => !headers.includes(header));
    if (missing.length) throw new AppError(400, 'VALIDATION_ERROR', `CSV is missing required columns: ${missing.join(', ')}`);
    const headerIndex = new Map(headers.map((header, index) => [header, index]));
    const result = { imported: 0, merged: 0, failed: 0 };
    const failedRows: string[][] = [];

    for (const [index, row] of rows.slice(1).entries()) {
      const value = (key: string) => {
        const column = headerIndex.get(key);
        return column === undefined ? undefined : row[column]?.trim() || undefined;
      };
      const parseInteger = (input: string | undefined) => input === undefined ? undefined : Number(input);
      const consent = value('consentgiven');
      const dto = plainToInstance(CreateLeadDto, {
        name: value('name'),
        phone: value('phone'),
        email: value('email'),
        source: value('source'),
        projectInterest: value('projectinterest') ?? value('project interest'),
        budgetMin: parseInteger(value('budgetmin') ?? value('budget min')),
        budgetMax: parseInteger(value('budgetmax') ?? value('budget max')),
        consentGiven: consent === undefined ? undefined : consent.toLowerCase() === 'true' ? true : consent.toLowerCase() === 'false' ? false : consent,
        consentText: value('consenttext'),
      });
      const validationErrors = await validate(dto);
      let reason: string | undefined = row.length !== headers.length
        ? `Expected ${headers.length} columns but found ${row.length}`
        : undefined;
      if (!reason && validationErrors.length) {
        reason = validationErrors.flatMap((e) => Object.values(e.constraints ?? {})).join('; ');
      } else if (!reason) {
        try {
          const created = await this.createLead(dto, actor, ip);
          if (created.meta.wasDuplicate) result.merged += 1;
          else result.imported += 1;
        } catch (error) {
          if (!(error instanceof HttpException)) throw error;
          const response = error.getResponse();
          reason = typeof response === 'string' ? response : (response as { message?: string }).message ?? error.message;
        }
      }

      if (reason) {
        result.failed += 1;
        failedRows.push([...headers.map((_, column) => row[column] ?? ''), reason]);
      }
    }

    const failedRowsCsvUrl = failedRows.length
      ? `data:text/csv;charset=utf-8;base64,${Buffer.from(toCsv([[...rows[0], 'error reason'], ...failedRows])).toString('base64')}`
      : null;
    return { data: result, failedRowsCsvUrl };
  }

  // ───────── reads ─────────
  async list(q: ListLeadsQuery, user: AuthUser) {
    const limit = q.limit ?? 25;
    const statuses = q.status?.split(',').map((status) => status.trim()) ?? [];
    if (statuses.some((status) => !Object.values(LeadStatus).includes(status as LeadStatus))) {
      throw new AppError(400, 'VALIDATION_ERROR', 'status contains an invalid lead status');
    }
    const where: Prisma.LeadWhereInput = {
      duplicateOfId: null,
      ...(statuses.length ? { status: { in: statuses as LeadStatus[] } } : {}),
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
    const visibleItems = items.map((lead) => ({
      ...lead,
      phone: user.role === 'sales_agent' ? lead.phone : `********${lead.phone.slice(-4)}`,
    }));
    return { data: visibleItems, meta: { nextCursor: hasMore ? items[items.length - 1].id : null } };
  }

  /** Out-of-scope and non-existent both → 404 (never confirm a lead exists to an unauthorised caller). */
  async getScoped(id: string, user: AuthUser) {
    const lead = await this.prisma.lead.findFirst({ where: { id, ...scopeFor(user) } });
    if (!lead) throw new AppError(404, 'NOT_FOUND', 'Lead not found');
    return lead;
  }

  async getDetail(id: string, user: AuthUser) {
    const lead = await this.prisma.lead.findFirst({
      where: { id, ...scopeFor(user) },
      include: { activities: { orderBy: { createdAt: 'desc' }, take: 20 }, siteVisits: { orderBy: { scheduledAt: 'desc' } }, deal: true },
    });
    if (!lead) throw new AppError(404, 'NOT_FOUND', 'Lead not found');
    return lead;
  }

  async listActivities(id: string, user: AuthUser, q: ListActivitiesQuery) {
    await this.getScoped(id, user);
    const limit = q.limit ?? 25;
    const rows = await this.prisma.leadActivity.findMany({
      where: { leadId: id, lead: { is: scopeFor(user) }, ...(q.type ? { type: q.type } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
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
        ...(q.source ? { source: q.source } : {}),
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

  async leaderboard(q: LeaderboardQuery) {
    const now = new Date();
    const period = q.period ?? 'month';
    const from = period === 'week'
      ? startOfWeek(now, { weekStartsOn: 1 })
      : period === 'quarter'
        ? startOfQuarter(now)
        : startOfMonth(now);
    const agents = await this.prisma.user.findMany({
      where: { status: 'ACTIVE', role: { name: { in: ['sales_agent', 'sales_manager'] } } },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    const agentIds = agents.map((agent) => agent.id);
    const assignmentEvents = await this.prisma.leadActivity.findMany({
      where: { type: 'ASSIGNMENT_CHANGE', createdAt: { gte: from, lte: now } },
      select: { leadId: true, metadata: true },
    });
    const assignedLeadIds = new Map<string, Set<string>>();
    for (const event of assignmentEvents) {
      const metadata = event.metadata;
      if (!metadata || Array.isArray(metadata) || typeof metadata !== 'object') continue;
      const assignedTo = metadata.toAgent;
      if (typeof assignedTo !== 'string' || !agentIds.includes(assignedTo)) continue;
      const ids = assignedLeadIds.get(assignedTo) ?? new Set<string>();
      ids.add(event.leadId);
      assignedLeadIds.set(assignedTo, ids);
    }
    const leadIds = [...new Set([...assignedLeadIds.values()].flatMap((ids) => [...ids]))];
    const leads = leadIds.length
      ? await this.prisma.lead.findMany({ where: { id: { in: leadIds }, duplicateOfId: null }, select: { id: true, assignedTo: true, createdAt: true } })
      : [];
    const responses = leadIds.length
      ? await this.prisma.leadActivity.findMany({
        where: { leadId: { in: leadIds }, type: 'STATUS_CHANGE', metadata: { path: ['to'], equals: 'CONTACTED' } },
        select: { leadId: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      })
      : [];
    const firstResponseByLead = new Map<string, Date>();
    for (const response of responses) {
      if (!firstResponseByLead.has(response.leadId)) firstResponseByLead.set(response.leadId, response.createdAt);
    }
    const leadById = new Map(leads.map((lead) => [lead.id, lead]));
    const responseTotals = new Map<string, { minutes: number; count: number }>();
    for (const [leadId, responseAt] of firstResponseByLead) {
      const lead = leadById.get(leadId);
      if (!lead?.assignedTo) continue;
      const current = responseTotals.get(lead.assignedTo) ?? { minutes: 0, count: 0 };
      current.minutes += Math.max(0, (responseAt.getTime() - lead.createdAt.getTime()) / 60_000);
      current.count += 1;
      responseTotals.set(lead.assignedTo, current);
    }

    const bookedDeals = await this.prisma.deal.findMany({
      where: { stage: 'BOOKED', closedAt: { gte: from, lte: now }, lead: { assignedTo: { in: agentIds } } },
      select: { value: true, lead: { select: { assignedTo: true } } },
    });
    const dealTotals = new Map<string, { count: number; value: Prisma.Decimal }>();
    for (const deal of bookedDeals) {
      const agentId = deal.lead.assignedTo;
      if (!agentId) continue;
      const current = dealTotals.get(agentId) ?? { count: 0, value: new Prisma.Decimal(0) };
      current.count += 1;
      current.value = current.value.add(deal.value);
      dealTotals.set(agentId, current);
    }
    return {
      data: agents.map((agent) => {
        const leadsHandled = assignedLeadIds.get(agent.id)?.size ?? 0;
        const responsesForAgent = responseTotals.get(agent.id);
        const deals = dealTotals.get(agent.id) ?? { count: 0, value: new Prisma.Decimal(0) };
        return {
          agentId: agent.id,
          agentName: agent.name,
          leadsHandled,
          conversionRate: leadsHandled ? Number(((deals.count / leadsHandled) * 100).toFixed(2)) : 0,
          averageFirstResponseMinutes: responsesForAgent
            ? Number((responsesForAgent.minutes / responsesForAgent.count).toFixed(1))
            : null,
          dealsClosed: deals.count,
          dealsClosedValue: deals.value.toString(),
        };
      }),
      meta: { period, from: from.toISOString(), to: now.toISOString() },
    };
  }

  // ───────── edits ─────────
  /** Optimistic locking: caller must send the version it read (If-Match). */
  async update(id: string, dto: UpdateLeadDto, version: number, user: AuthUser) {
    const lead = await this.getScoped(id, user);
    const min = dto.budgetMin ?? lead.budgetMin; const max = dto.budgetMax ?? lead.budgetMax;
    if (min != null && max != null && min > max) throw new AppError(400, 'VALIDATION_ERROR', 'budgetMin must be ≤ budgetMax');
    const res = await this.prisma.lead.updateMany({ where: { id, version, ...scopeFor(user) }, data: { ...dto, version: { increment: 1 } } });
    if (res.count === 0) {
      const current = await this.prisma.lead.findFirst({ where: { id, ...scopeFor(user) }, select: { version: true } });
      if (!current) throw new AppError(404, 'NOT_FOUND', 'Lead not found');
      throw new AppError(409, 'CONFLICT', 'Lead was modified by someone else — refresh and retry', { currentVersion: current.version });
    }
    return this.prisma.lead.findUniqueOrThrow({ where: { id } });
  }

  async changeStatus(id: string, dto: ChangeStatusDto, user: AuthUser) {
    const lead = await this.getScoped(id, user);
    if (!MANUALLY_REQUESTABLE.includes(dto.status)) {
      throw new AppError(422, 'ILLEGAL_TRANSITION', `${dto.status} is set automatically by site visits / deals, not directly`, { legalNextStates: legalNextStates(lead.status) });
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      await this.assertScoped(tx, id, user);
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
    const updated = await this.prisma.$transaction(async (tx) => {
      await this.assertScoped(tx, id, user);
      return this.sm.transition(tx, id, 'CONTACTED', user.id, { reactivate: true, notes });
    });
    this.events.emit('lead.status_changed', { leadId: id, from: 'LOST', to: 'CONTACTED' });
    return updated;
  }

  async assign(id: string, dto: AssignDto, user: AuthUser) {
    const lead = await this.prisma.lead.findUnique({ where: { id } });
    if (!lead) throw new AppError(404, 'NOT_FOUND', 'Lead not found');
    const agent = await this.prisma.user.findFirst({ where: { id: dto.agentId, status: 'ACTIVE', role: { name: { in: ['sales_agent', 'sales_manager'] } } } });
    if (!agent) throw new AppError(400, 'VALIDATION_ERROR', 'agentId must be an active sales agent/manager');
    const updated = await this.prisma.$transaction(async (tx) => {
      const changed = await tx.lead.updateMany({
        where: { id, version: lead.version },
        data: { assignedTo: agent.id, version: { increment: 1 } },
      });
      if (!changed.count) throw new AppError(409, 'CONFLICT', 'Lead changed while being reassigned; refresh and retry');
      const l = await tx.lead.findUniqueOrThrow({ where: { id } });
      await tx.leadActivity.create({
        data: { leadId: id, type: 'ASSIGNMENT_CHANGE', createdBy: user.id, metadata: { fromAgent: lead.assignedTo, toAgent: agent.id, reason: 'manual_reassignment' } },
      });
      await tx.auditLog.create({ data: { actorId: user.id, action: 'lead.assigned', entityType: 'Lead', entityId: id, before: { assignedTo: lead.assignedTo }, after: { assignedTo: agent.id } } });
      return l;
    });
    this.events.emit('lead.assigned', { leadId: id, agentId: agent.id });
    return updated;
  }

  async reassignAgent(dto: BulkReassignDto, user: AuthUser) {
    const source = await this.prisma.user.findUnique({ where: { id: dto.fromAgentId } });
    if (!source) throw new AppError(404, 'NOT_FOUND', 'Source agent not found');
    if (dto.toAgentId === dto.fromAgentId) throw new AppError(400, 'VALIDATION_ERROR', 'Source and target agents must differ');
    if (dto.toAgentId) {
      const target = await this.prisma.user.findFirst({
        where: { id: dto.toAgentId, status: 'ACTIVE', role: { name: { in: ['sales_agent', 'sales_manager'] } } },
      });
      if (!target) throw new AppError(400, 'VALIDATION_ERROR', 'toAgentId must be an active sales agent/manager');
    }

    const leads = await this.prisma.lead.findMany({
      where: { assignedTo: dto.fromAgentId, duplicateOfId: null, status: { notIn: ['BOOKED', 'LOST'] } },
      select: { id: true, assignedTo: true, version: true, projectInterest: true },
    });
    let reassigned = 0;
    let unassigned = 0;
    for (const lead of leads) {
      const targetId = dto.toAgentId ?? await this.assignment.findAssignee(lead.projectInterest ?? undefined, [dto.fromAgentId]);
      await this.prisma.$transaction(async (tx) => {
        const changed = await tx.lead.updateMany({
          where: { id: lead.id, assignedTo: dto.fromAgentId, version: lead.version },
          data: { assignedTo: targetId, version: { increment: 1 } },
        });
        if (!changed.count) throw new AppError(409, 'CONFLICT', `Lead ${lead.id} changed during agent offboarding`);
        await tx.leadActivity.create({
          data: {
            leadId: lead.id,
            type: 'ASSIGNMENT_CHANGE',
            createdBy: user.id,
            metadata: { fromAgent: dto.fromAgentId, toAgent: targetId, reason: 'offboarding_reassignment' },
          },
        });
        await tx.auditLog.create({
          data: { actorId: user.id, action: 'lead.assigned', entityType: 'Lead', entityId: lead.id, before: { assignedTo: dto.fromAgentId }, after: { assignedTo: targetId } },
        });
      });
      if (targetId) {
        reassigned += 1;
        this.events.emit('lead.assigned', { leadId: lead.id, agentId: targetId });
      } else {
        unassigned += 1;
        this.events.emit('lead.unassigned', { leadId: lead.id });
      }
    }
    return { data: { reassigned, unassigned } };
  }

  /** Only for accidental empty entries; anything with real history is never hard-deleted. */
  async remove(id: string, user: AuthUser) {
    const lead = await this.getScoped(id, user);
    await this.prisma.$transaction(async (tx) => {
      await this.assertScoped(tx, id, user);
      const [activities, visits, deal] = await Promise.all([
        tx.leadActivity.count({ where: { leadId: id, type: { not: 'ASSIGNMENT_CHANGE' } } }),
        tx.siteVisit.count({ where: { leadId: id } }),
        tx.deal.count({ where: { leadId: id } }),
      ]);
      if (activities || visits || deal) throw new AppError(409, 'CONFLICT', 'Lead has history and cannot be deleted (use the DPDP erasure workflow)');
      if (user.role === 'sales_agent' && lead.createdAt < startOfDay(new Date())) {
        throw new AppError(403, 'FORBIDDEN', 'Agents may only delete leads created today');
      }
      await tx.leadActivity.deleteMany({ where: { leadId: id } });
      const deleted = await tx.lead.deleteMany({ where: { id, ...scopeFor(user) } });
      if (!deleted.count) throw new AppError(404, 'NOT_FOUND', 'Lead not found');
    });
    return { deleted: true };
  }

  // ───────── activities ─────────
  async addActivity(id: string, dto: CreateActivityDto, user: AuthUser) {
    await this.getScoped(id, user);
    if (SYSTEM_ONLY.includes(dto.type)) throw new AppError(400, 'VALIDATION_ERROR', `${dto.type} activities are written by the system only`);
    const result = await this.prisma.$transaction(async (tx) => {
      const lead = await tx.lead.findFirst({ where: { id, ...scopeFor(user) } });
      if (!lead) throw new AppError(404, 'NOT_FOUND', 'Lead not found');
      const a = await tx.leadActivity.create({ data: { leadId: id, type: dto.type, notes: dto.notes, metadata: dto.metadata as Prisma.InputJsonValue | undefined, createdBy: user.id } });
      // first touch stops the SLA clock: NEW → CONTACTED as a side effect
      if (lead.status === 'NEW' && lead.assignedTo && ['CALL', 'WHATSAPP', 'NOTE'].includes(dto.type)) {
        await this.sm.transition(tx, id, 'CONTACTED', user.id);
      }
      return { activity: a, firstContact: lead.status === 'NEW' && Boolean(lead.assignedTo) && ['CALL', 'WHATSAPP', 'NOTE'].includes(dto.type) };
    });
    if (result.firstContact) {
      this.events.emit('lead.status_changed', { leadId: id, from: 'NEW', to: 'CONTACTED' });
    }
    return result.activity;
  }

  private async assertScoped(tx: Tx, id: string, user: AuthUser) {
    const lead = await tx.lead.findFirst({ where: { id, ...scopeFor(user) }, select: { id: true } });
    if (!lead) throw new AppError(404, 'NOT_FOUND', 'Lead not found');
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
