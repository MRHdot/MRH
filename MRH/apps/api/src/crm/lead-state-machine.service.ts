import { Injectable } from '@nestjs/common';
import { Lead, LeadStatus } from '@prisma/client';
import { AppError } from '../common/errors';
import { Tx } from '../prisma/prisma.module';
import { isLegal, legalNextStates, LOST_REASONS } from './lead-transitions';

export interface TransitionOpts { lostReason?: string; notes?: string; reactivate?: boolean; extra?: Record<string, unknown>; }

/**
 * The ONLY code path that writes Lead.status. Every status-changing endpoint, site-visit
 * and deal operation goes through transition(), inside the caller's transaction.
 */
@Injectable()
export class LeadStateMachineService {
  async transition(tx: Tx, leadId: string, to: LeadStatus, actorId: string, opts: TransitionOpts = {}): Promise<Lead> {
    const lead = await tx.lead.findUniqueOrThrow({ where: { id: leadId } });
    if (lead.status === to) return lead;

    const isReactivation = opts.reactivate && lead.status === 'LOST' && to === 'CONTACTED';
    if (!isReactivation && !isLegal(lead.status, to)) {
      throw new AppError(422, 'ILLEGAL_TRANSITION', `Cannot go from ${lead.status} to ${to} directly`, {
        legalNextStates: legalNextStates(lead.status),
      });
    }
    this.checkGuards(lead, to, opts);

    const updated = await tx.lead.update({
      where: { id: leadId },
      data: {
        status: to,
        version: { increment: 1 },
        ...(to === 'LOST' ? { lostReason: opts.lostReason } : {}),
        ...(lead.status === 'LOST' ? { lostReason: null } : {}),
        ...(to !== 'NEW' ? { slaBreached: false } : {}),
      },
    });
    await tx.leadActivity.create({
      data: {
        leadId, type: 'STATUS_CHANGE', notes: opts.notes, createdBy: actorId,
        metadata: { from: lead.status, to, ...(opts.lostReason ? { lostReason: opts.lostReason } : {}), ...(opts.extra ?? {}) },
      },
    });
    await tx.auditLog.create({
      data: { actorId, action: 'lead.status_changed', entityType: 'Lead', entityId: leadId, before: { status: lead.status }, after: { status: to } },
    });
    return updated;
  }

  private checkGuards(lead: Lead, to: LeadStatus, opts: TransitionOpts) {
    if (to === 'CONTACTED' && !opts.reactivate && !lead.assignedTo) {
      throw new AppError(422, 'GUARD_FAILED', 'Lead must be assigned to an agent before it can be contacted');
    }
    if (to === 'QUALIFIED' && lead.status === 'CONTACTED' && lead.budgetMin == null && lead.budgetMax == null) {
      throw new AppError(422, 'GUARD_FAILED', 'Set a budget (min or max) before qualifying the lead');
    }
    if (to === 'LOST') {
      if (!opts.lostReason || !(LOST_REASONS as readonly string[]).includes(opts.lostReason)) {
        throw new AppError(400, 'VALIDATION_ERROR', `lostReason is required and must be one of: ${LOST_REASONS.join(', ')}`);
      }
      if (opts.lostReason === 'OTHER' && !opts.notes?.trim()) {
        throw new AppError(400, 'VALIDATION_ERROR', 'notes are mandatory when lostReason is OTHER');
      }
    }
  }
}
