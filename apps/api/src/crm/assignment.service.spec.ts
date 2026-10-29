import { AgentAvailabilityPort } from '../integrations/ports';
import { PrismaService } from '../prisma/prisma.module';
import { AssignmentService } from './assignment.service';

describe('AssignmentService', () => {
  const setup = (agents: { id: string; specialization: string[] }[], leads: { assignedTo: string | null; activities: { createdAt: Date }[] }[]) => {
    const prisma = {
      user: { findMany: jest.fn().mockResolvedValue(agents) },
      lead: { findMany: jest.fn().mockResolvedValue(leads) },
    } as unknown as PrismaService;
    const availability = { getUnavailableAgentIds: jest.fn().mockResolvedValue([]) } as unknown as AgentAvailabilityPort;
    return { service: new AssignmentService(prisma, availability), prisma, availability };
  };

  it('prefers a matching specialization before balancing workload', async () => {
    const { service } = setup(
      [{ id: 'generalist', specialization: [] }, { id: 'powai', specialization: ['Powai'] }],
      [{ assignedTo: 'powai', activities: [] }, { assignedTo: 'powai', activities: [] }],
    );
    await expect(service.findAssignee('2BHK in Powai')).resolves.toBe('powai');
  });

  it('balances by open leads, then chooses the longest-unassigned agent', async () => {
    const { service } = setup(
      [{ id: 'agent-a', specialization: [] }, { id: 'agent-b', specialization: [] }],
      [
        { assignedTo: 'agent-a', activities: [{ createdAt: new Date('2026-01-03T00:00:00Z') }] },
        { assignedTo: 'agent-b', activities: [{ createdAt: new Date('2026-01-01T00:00:00Z') }] },
      ],
    );
    await expect(service.findAssignee()).resolves.toBe('agent-b');
  });

  it('returns null when every eligible agent is unavailable', async () => {
    const { service, availability } = setup([{ id: 'agent-a', specialization: [] }], []);
    jest.mocked(availability.getUnavailableAgentIds).mockResolvedValue(['agent-a']);
    await expect(service.findAssignee()).resolves.toBeNull();
  });
});
