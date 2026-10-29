import { Injectable } from '@nestjs/common';
import { AgentAvailabilityPort } from '../integrations/ports';
import { PrismaService } from '../prisma/prisma.module';

/** Load-balanced auto-assignment: fewest open leads, tie-broken by longest-since-last-assignment. */
@Injectable()
export class AssignmentService {
  constructor(private prisma: PrismaService, private availability: AgentAvailabilityPort) {}

  async findAssignee(projectInterest?: string, excludedAgentIds: string[] = []): Promise<string | null> {
    const agents = await this.prisma.user.findMany({
      where: { status: 'ACTIVE', role: { name: { in: ['sales_agent', 'sales_manager'] } } },
      select: { id: true, specialization: true },
    });
    const away = new Set(await this.availability.getUnavailableAgentIds(new Date()));
    let eligible = agents.filter((agent) => !away.has(agent.id) && !excludedAgentIds.includes(agent.id));
    if (projectInterest?.trim()) {
      const interest = projectInterest.toLocaleLowerCase();
      const specialized = eligible.filter((agent) => agent.specialization.some((tag) => {
        const normalizedTag = tag.toLocaleLowerCase();
        if (!normalizedTag) return false;
        return interest.includes(normalizedTag) || normalizedTag.includes(interest);
      }));
      if (specialized.length) eligible = specialized;
    }
    const ids = eligible.map((agent) => agent.id);
    if (ids.length === 0) return null;

    const assignedLeads = await this.prisma.lead.findMany({
      where: { assignedTo: { in: ids }, status: { notIn: ['BOOKED', 'LOST'] }, duplicateOfId: null },
      select: {
        assignedTo: true,
        activities: {
          where: { type: 'ASSIGNMENT_CHANGE' },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { createdAt: true },
        },
      },
    });
    const m = new Map<string, { n: number; last: number }>();
    for (const lead of assignedLeads) {
      if (!lead.assignedTo) continue;
      const current = m.get(lead.assignedTo) ?? { n: 0, last: 0 };
      current.n += 1;
      current.last = Math.max(current.last, lead.activities[0]?.createdAt.getTime() ?? 0);
      m.set(lead.assignedTo, current);
    }
    ids.sort((a, b) => {
      const x = m.get(a) ?? { n: 0, last: 0 }; const y = m.get(b) ?? { n: 0, last: 0 };
      return x.n - y.n || x.last - y.last;
    });
    return ids[0];
  }
}
