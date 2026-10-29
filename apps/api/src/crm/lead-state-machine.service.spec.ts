import { AppError } from '../common/errors';
import { Tx } from '../prisma/prisma.module';
import { LeadStateMachineService } from './lead-state-machine.service';

describe('LeadStateMachineService', () => {
  const currentLead = { id: 'lead-1', status: 'NEW' as const, version: 3, assignedTo: 'agent-1', budgetMin: null, budgetMax: null };
  const txWith = (updateCount: number) => {
    const tx = {
      lead: {
        findUniqueOrThrow: jest.fn()
          .mockResolvedValueOnce(currentLead)
          .mockResolvedValueOnce({ ...currentLead, status: 'CONTACTED', version: 4 }),
        updateMany: jest.fn().mockResolvedValue({ count: updateCount }),
      },
      leadActivity: { create: jest.fn().mockResolvedValue({}) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    } as unknown as Tx;
    return tx;
  };

  it('writes the status with the read version and records audit history', async () => {
    const tx = txWith(1);
    const service = new LeadStateMachineService();
    await service.transition(tx, 'lead-1', 'CONTACTED', 'agent-1');
    expect(tx.lead.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'lead-1', status: 'NEW', version: 3 },
    }));
    expect(tx.leadActivity.create).toHaveBeenCalled();
    expect(tx.auditLog.create).toHaveBeenCalled();
  });

  it('rejects a concurrent stale transition', async () => {
    const tx = txWith(0);
    const service = new LeadStateMachineService();
    await expect(service.transition(tx, 'lead-1', 'CONTACTED', 'agent-1'))
      .rejects.toMatchObject({ status: 409 });
    expect(tx.leadActivity.create).not.toHaveBeenCalled();
  });

  it('rejects a lifecycle skip before writing', async () => {
    const tx = txWith(1);
    const service = new LeadStateMachineService();
    await expect(service.transition(tx, 'lead-1', 'BOOKED', 'agent-1'))
      .rejects.toBeInstanceOf(AppError);
    expect(tx.lead.updateMany).not.toHaveBeenCalled();
  });
});
