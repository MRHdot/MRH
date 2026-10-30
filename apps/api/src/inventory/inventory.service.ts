import { Injectable } from '@nestjs/common';
import { addHours } from 'date-fns';
import { AppError } from '../common/errors';
import { InventoryPort } from '../integrations/ports';
import { PrismaService, Tx } from '../prisma/prisma.module';

@Injectable()
export class InventoryService extends InventoryPort {
  constructor(private prisma: PrismaService) { super(); }

  async assertProjectExists(projectId: string): Promise<void> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
    if (!project) throw new AppError(404, 'NOT_FOUND', 'Project not found');
  }

  async holdUnitForDeal(tx: Tx, unitId: string, dealId: string): Promise<Date> {
    const unit = await tx.unit.findUnique({ where: { id: unitId }, include: { project: true } });
    if (!unit) throw new AppError(404, 'NOT_FOUND', 'Unit not found');
    if (unit.project.status === 'ON_HOLD') throw new AppError(409, 'PROJECT_ON_HOLD', 'Project is on hold');
    if (unit.status === 'SOLD') throw new AppError(409, 'UNIT_UNAVAILABLE', 'Unit already sold');
    if (unit.status === 'HELD' && unit.heldUntil && unit.heldUntil > new Date()) {
      throw new AppError(409, 'UNIT_UNAVAILABLE', 'Unit already held by another deal');
    }

    const heldUntil = addHours(new Date(), 48);
    await tx.unit.update({
      where: { id: unitId },
      data: { status: 'HELD', heldUntil, heldByDealId: dealId },
    });
    return heldUntil;
  }

  async extendHold(tx: Tx, unitId: string, until: Date): Promise<void> {
    const unit = await tx.unit.findUnique({ where: { id: unitId } });
    if (!unit) throw new AppError(404, 'NOT_FOUND', 'Unit not found');
    await tx.unit.update({ where: { id: unitId }, data: { heldUntil: until } });
  }

  async releaseUnit(tx: Tx, unitId: string): Promise<void> {
    const unit = await tx.unit.findUnique({ where: { id: unitId } });
    if (!unit) throw new AppError(404, 'NOT_FOUND', 'Unit not found');
    await tx.unit.update({
      where: { id: unitId },
      data: { status: 'AVAILABLE', heldUntil: null, heldByDealId: null },
    });
  }

  async markUnitSold(tx: Tx, unitId: string): Promise<void> {
    const unit = await tx.unit.findUnique({ where: { id: unitId }, include: { project: true } });
    if (!unit) throw new AppError(404, 'NOT_FOUND', 'Unit not found');
    await tx.unit.update({
      where: { id: unitId },
      data: { status: 'SOLD', heldUntil: null, heldByDealId: null },
    });
    await this.checkAndFlipProjectSoldOut(tx, unit.projectId);
  }

  async createProject(data: any) {
    const project = await this.prisma.project.create({
      data: {
        name: data.name,
        developerName: data.developerName ?? null,
        description: data.description ?? null,
        location: data.location,
        locality: data.locality,
        city: data.city ?? 'Mumbai',
        pincode: data.pincode ?? null,
        latitude: data.latitude ?? null,
        longitude: data.longitude ?? null,
        reraId: data.reraId,
        reraValidTill: new Date(data.reraValidTill),
        amenities: data.amenities ?? [],
        status: data.status ?? 'UPCOMING',
      },
    });
    return project;
  }

  async listProjects() {
    return this.prisma.project.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async getProject(id: string) {
    const project = await this.prisma.project.findUnique({
      where: { id },
      include: { units: { orderBy: { unitNo: 'asc' } } },
    });
    if (!project) throw new AppError(404, 'NOT_FOUND', 'Project not found');
    return project;
  }

  async updateProject(id: string, data: any) {
    const project = await this.prisma.project.findUnique({ where: { id } });
    if (!project) throw new AppError(404, 'NOT_FOUND', 'Project not found');

    if (data.reraValidTill && new Date(data.reraValidTill) > project.reraValidTill) {
      data.reraAlert90Sent = false;
      data.reraAlert30Sent = false;
      data.reraAlert7Sent = false;
    }

    return this.prisma.project.update({ where: { id }, data });
  }

  async updateProjectStatus(id: string, status: string) {
    const project = await this.prisma.project.findUnique({ where: { id } });
    if (!project) throw new AppError(404, 'NOT_FOUND', 'Project not found');

    const allowed = ['UPCOMING', 'ACTIVE', 'ON_HOLD', 'SOLD_OUT'];
    if (!allowed.includes(status)) throw new AppError(422, 'VALIDATION_ERROR', 'Invalid project status');

    return this.prisma.project.update({ where: { id }, data: { status: status as any } });
  }

  async createUnit(data: any) {
    return this.prisma.unit.create({
      data: {
        projectId: data.projectId,
        unitNo: data.unitNo,
        tower: data.tower ?? null,
        floor: data.floor ?? null,
        type: data.type,
        areaSqft: Number(data.areaSqft),
        price: Number(data.price),
        status: data.status ?? 'AVAILABLE',
        floorPlanUrl: data.floorPlanUrl ?? null,
      },
    });
  }

  async listUnits(filters: any = {}) {
    const where: any = {
      ...(filters.projectId ? { projectId: filters.projectId } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.project ? { projectId: filters.project } : {}),
      ...(filters.type ? { type: filters.type } : {}),
      ...(filters.priceMin || filters.priceMax ? {
        price: {
          ...(filters.priceMin ? { gte: Number(filters.priceMin) } : {}),
          ...(filters.priceMax ? { lte: Number(filters.priceMax) } : {}),
        },
      } : {}),
    };

    return this.prisma.unit.findMany({
      where,
      include: { project: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getUnit(id: string) {
    const unit = await this.prisma.unit.findUnique({
      where: { id },
      include: {
        project: true,
        priceHistory: { orderBy: { changedAt: 'desc' }, take: 10 },
      },
    });
    if (!unit) throw new AppError(404, 'NOT_FOUND', 'Unit not found');
    return unit;
  }

  async updateUnit(id: string, data: any) {
    const { price, status, ...safe } = data;
    const unit = await this.prisma.unit.findUnique({ where: { id } });
    if (!unit) throw new AppError(404, 'NOT_FOUND', 'Unit not found');
    return this.prisma.unit.update({ where: { id }, data: safe });
  }

  async updatePrice(unitId: string, newPrice: number, reason?: string, actorId = 'system') {
    const unit = await this.prisma.unit.findUnique({ where: { id: unitId } });
    if (!unit) throw new AppError(404, 'NOT_FOUND', 'Unit not found');

    const result = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.unit.update({ where: { id: unitId }, data: { price: Number(newPrice) } });
      await tx.unitPriceHistory.create({
        data: {
          unitId,
          oldPrice: unit.price,
          newPrice: Number(newPrice),
          changedBy: actorId,
          reason: reason ?? 'price_update',
        },
      });
      return updated;
    });

    return result;
  }

  async blockUnit(tx: Tx, unitId: string, reason: string) {
    const unit = await tx.unit.findUnique({ where: { id: unitId } });
    if (!unit) throw new AppError(404, 'NOT_FOUND', 'Unit not found');
    if (!reason || !reason.trim()) throw new AppError(422, 'VALIDATION_ERROR', 'blockedReason is required');
    if (unit.status === 'SOLD' || unit.status === 'HELD') {
      throw new AppError(409, 'UNIT_UNAVAILABLE', 'Only AVAILABLE units can be blocked');
    }

    return tx.unit.update({
      where: { id: unitId },
      data: { status: 'BLOCKED', blockedReason: reason.trim() },
    });
  }

  async blockUnitById(unitId: string, reason: string) {
    return this.blockUnit(this.prisma, unitId, reason);
  }

  async unblockUnit(tx: Tx, unitId: string) {
    const unit = await tx.unit.findUnique({ where: { id: unitId } });
    if (!unit) throw new AppError(404, 'NOT_FOUND', 'Unit not found');
    if (unit.status !== 'BLOCKED') {
      throw new AppError(409, 'UNIT_UNAVAILABLE', 'Only blocked units can be unblocked');
    }

    return tx.unit.update({
      where: { id: unitId },
      data: { status: 'AVAILABLE', blockedReason: null },
    });
  }

  async unblockUnitById(unitId: string) {
    return this.unblockUnit(this.prisma, unitId);
  }

  async getProjectReraStatus(projectId: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new AppError(404, 'NOT_FOUND', 'Project not found');

    const msLeft = project.reraValidTill.getTime() - Date.now();
    const daysLeft = Math.ceil(msLeft / (1000 * 60 * 60 * 24));

    let severity: 'OK' | 'WARNING_90' | 'WARNING_30' | 'WARNING_7' | 'EXPIRED' = 'OK';
    if (daysLeft < 0) severity = 'EXPIRED';
    else if (daysLeft <= 7) severity = 'WARNING_7';
    else if (daysLeft <= 30) severity = 'WARNING_30';
    else if (daysLeft <= 90) severity = 'WARNING_90';

    return {
      reraId: project.reraId,
      reraValidTill: project.reraValidTill,
      daysRemaining: daysLeft,
      severity,
    };
  }

  async getComplianceDashboard() {
    const projects = await this.prisma.project.findMany({
      select: {
        id: true,
        name: true,
        reraId: true,
        reraValidTill: true,
        status: true,
      },
    });

    return {
      data: projects.map((project) => ({
        ...project,
        ...this.getProjectReraStatusValue(project.reraValidTill),
      })),
    };
  }

  async getHeatmap(projectId?: string) {
    const units = await this.prisma.unit.findMany({
      where: projectId ? { projectId } : {},
      orderBy: [{ tower: 'asc' }, { floor: 'asc' }, { unitNo: 'asc' }],
      select: { id: true, unitNo: true, tower: true, floor: true, type: true, status: true },
    });

    const towers = new Map<string, Map<number, any[]>>();
    for (const unit of units) {
      const tower = unit.tower ?? 'Main';
      if (!towers.has(tower)) towers.set(tower, new Map());
      const floorMap = towers.get(tower)!;
      const floor = unit.floor ?? 0;
      if (!floorMap.has(floor)) floorMap.set(floor, []);
      floorMap.get(floor)!.push({ unitNo: unit.unitNo, status: unit.status, type: unit.type });
    }

    return {
      data: {
        towers: Array.from(towers.entries()).map(([tower, floorMap]) => ({
          tower,
          floors: Array.from(floorMap.entries()).map(([floor, entries]) => ({ floor, units: entries })),
        })),
      },
    };
  }

  private getProjectReraStatusValue(reraValidTill: Date) {
    const daysLeft = Math.ceil((reraValidTill.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    if (daysLeft < 0) return { severity: 'EXPIRED', daysRemaining: daysLeft };
    if (daysLeft <= 7) return { severity: 'WARNING_7', daysRemaining: daysLeft };
    if (daysLeft <= 30) return { severity: 'WARNING_30', daysRemaining: daysLeft };
    if (daysLeft <= 90) return { severity: 'WARNING_90', daysRemaining: daysLeft };
    return { severity: 'OK', daysRemaining: daysLeft };
  }

  private async checkAndFlipProjectSoldOut(tx: Tx, projectId: string) {
    const available = await tx.unit.count({ where: { projectId, status: 'AVAILABLE' } });
    if (available === 0) {
      await tx.project.update({ where: { id: projectId }, data: { status: 'SOLD_OUT' } });
    }
  }
}
