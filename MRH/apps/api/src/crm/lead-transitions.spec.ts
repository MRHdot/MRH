import { isLegal, legalNextStates } from './lead-transitions';

describe('lead lifecycle', () => {
  it('allows the happy path', () => {
    expect(isLegal('NEW', 'CONTACTED')).toBe(true);
    expect(isLegal('CONTACTED', 'QUALIFIED')).toBe(true);
    expect(isLegal('QUALIFIED', 'SITE_VISIT_SCHEDULED')).toBe(true);
    expect(isLegal('SITE_VISIT_SCHEDULED', 'NEGOTIATION')).toBe(true);
    expect(isLegal('NEGOTIATION', 'BOOKED')).toBe(true);
  });
  it('rejects skipping stages', () => {
    expect(isLegal('NEW', 'BOOKED')).toBe(false);
    expect(isLegal('NEW', 'NEGOTIATION')).toBe(false);
  });
  it('LOST is reachable from every non-terminal state, never from BOOKED', () => {
    for (const s of ['NEW', 'CONTACTED', 'QUALIFIED', 'SITE_VISIT_SCHEDULED', 'NEGOTIATION'] as const) expect(isLegal(s, 'LOST')).toBe(true);
    expect(isLegal('BOOKED', 'LOST')).toBe(false);
  });
  it('terminal states have no exits', () => {
    expect(legalNextStates('BOOKED')).toEqual([]);
    expect(legalNextStates('LOST')).toEqual([]);
  });
});
