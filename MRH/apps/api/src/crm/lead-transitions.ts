import { LeadStatus } from '@prisma/client';

/** Single source of truth for the lead lifecycle (handbook §Lead lifecycle). */
const FORWARD: Record<LeadStatus, LeadStatus[]> = {
  NEW: ['CONTACTED'],
  CONTACTED: ['QUALIFIED'],
  QUALIFIED: ['SITE_VISIT_SCHEDULED'],
  SITE_VISIT_SCHEDULED: ['NEGOTIATION', 'QUALIFIED'],   // QUALIFIED = no-show / not interested / reschedule
  NEGOTIATION: ['BOOKED', 'QUALIFIED'],                 // QUALIFIED = hold expired / deal cancelled
  BOOKED: [],
  LOST: [],                                             // leaves LOST only via explicit reactivate()
};

export function legalNextStates(from: LeadStatus): LeadStatus[] {
  const next = [...FORWARD[from]];
  if (from !== 'BOOKED' && from !== 'LOST') next.push('LOST');
  return next;
}
export const isLegal = (from: LeadStatus, to: LeadStatus) => legalNextStates(from).includes(to);

/** Transitions a client may request directly; the rest are driven by site visits / deals. */
export const MANUALLY_REQUESTABLE: LeadStatus[] = ['CONTACTED', 'QUALIFIED', 'LOST'];

export const LOST_REASONS = ['BUDGET_MISMATCH', 'CHOSE_COMPETITOR', 'UNRESPONSIVE', 'NOT_GENUINE', 'PLAN_CHANGED', 'OTHER'] as const;
