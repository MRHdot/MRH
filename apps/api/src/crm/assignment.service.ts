import { Injectable } from '@nestjs/common';
import { AgentAvailabilityPort } from '../integrations/ports';
import { PrismaService } from '../prisma/prisma.module';

/** Load-balanced auto-assignment: fewest open leads, tie-broken by longest-since-last-assignment. */
@Injectable()
export class AssignmentService {
  constructor(private prisma: PrismaService, private availability: AgentAvailabilityPort) {}

  async findAssignee(): Promise<string | null> {
    const agents = await this.prisma.user.findMany({
      where: { status: 'ACTIVE', role: { name: { in: ['sales_agent', 'sales_manager'] } } },
      select: { id: true },
    });
    const away = new Set(await this.availability.getUnavailableAgentIds(new Date()));
    const ids = agents.map((a) => a.id).filter((id) => !away.has(id));
    if (ids.length === 0) return null;

    const stats = await this.prisma.lead.groupBy({
      by: ['assignedTo'],
      where: { assignedTo: { in: ids }, status: { notIn: ['BOOKED', 'LOST'] }, duplicateOfId: null },
      _count: { _all: true },
      _max: { createdAt: true },
    });
    const m = new Map(stats.map((s) => [s.assignedTo, { n: s._count._all, last: s._max.createdAt?.getTime() ?? 0 }]));
    ids.sort((a, b) => {
      const x = m.get(a) ?? { n: 0, last: 0 }; const y = m.get(b) ?? { n: 0, last: 0 };
      return x.n - y.n || x.last - y.last;
    });
    return ids[0];
  }
}
