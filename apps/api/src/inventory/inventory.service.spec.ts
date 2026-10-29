import { PrismaService } from '../prisma/prisma.module';
import { InventoryService } from './inventory.service';

describe('InventoryService', () => {
  it('holds a unit for a deal without allowing a second active hold', async () => {
    const tx = {
      unit: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'unit-1',
          status: 'AVAILABLE',
          projectId: 'project-1',
          project: { status: 'ACTIVE' },
          heldUntil: null,
          heldByDealId: null,
        }),
        update: jest.fn().mockResolvedValue({
          id: 'unit-1',
          status: 'HELD',
          heldUntil: new Date('2026-10-30T12:00:00.000Z'),
          heldByDealId: 'deal-1',
        }),
      },
      project: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
      },
    } as unknown as PrismaService;

    const service = new InventoryService(tx as any);
    const heldUntil = await service.holdUnitForDeal(tx as any, 'unit-1', 'deal-1');

    expect(heldUntil).toBeInstanceOf(Date);
    expect(tx.unit.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'unit-1' },
      data: expect.objectContaining({ status: 'HELD', heldByDealId: 'deal-1' }),
    }));
  });

  it('marks a unit sold and flips a project to sold out when no available units remain', async () => {
    const tx = {
      unit: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'unit-1',
          projectId: 'project-1',
          status: 'HELD',
          project: { status: 'ACTIVE' },
        }),
        update: jest.fn().mockResolvedValue({ id: 'unit-1', projectId: 'project-1', status: 'SOLD' }),
        count: jest.fn().mockResolvedValue(0),
      },
      project: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({ id: 'project-1', status: 'SOLD_OUT' }),
      },
    } as unknown as PrismaService;

    const service = new InventoryService(tx as any);
    await expect(service.markUnitSold(tx as any, 'unit-1')).resolves.toBeUndefined();
  });

  it('blocks and unblocks a unit only through the dedicated inventory lifecycle methods', async () => {
    const tx = {
      unit: {
        findUnique: jest.fn()
          .mockResolvedValueOnce({ id: 'unit-1', status: 'AVAILABLE', blockedReason: null })
          .mockResolvedValueOnce({ id: 'unit-1', status: 'BLOCKED', blockedReason: 'legal' }),
        update: jest.fn()
          .mockResolvedValueOnce({ id: 'unit-1', status: 'BLOCKED', blockedReason: 'legal' })
          .mockResolvedValueOnce({ id: 'unit-1', status: 'AVAILABLE', blockedReason: null }),
      },
    } as any;

    const service = new InventoryService(tx as any);
    await expect(service.blockUnit(tx as any, 'unit-1', 'legal')).resolves.toMatchObject({ status: 'BLOCKED' });
    await expect(service.unblockUnit(tx as any, 'unit-1')).resolves.toMatchObject({ status: 'AVAILABLE' });
  });

  it('calculates a project RERA severity from its remaining validity', async () => {
    const prisma = {
      project: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'project-1',
          name: 'Skyline',
          reraId: 'RERA-1',
          reraValidTill: new Date(Date.now() + 40 * 24 * 60 * 60 * 1000),
          status: 'ACTIVE',
        }),
      },
    } as unknown as PrismaService;

    const service = new InventoryService(prisma as any);
    const result = await service.getProjectReraStatus('project-1');

    expect(result.severity).toBe('WARNING_90');
  });
});
