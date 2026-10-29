import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Queue, Worker } from 'bullmq';
import { subHours } from 'date-fns';
import { PrismaService } from '../prisma/prisma.module';
import { WhatsappPort } from '../integrations/ports';

const QUEUE_NAME = 'crm-site-visit-reminders';
type ReminderJob = { siteVisitId: string; expectedAt: number; hoursBefore: 1 | 3 };

@Injectable()
export class VisitReminderQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(VisitReminderQueueService.name);
  private readonly queue: Queue<ReminderJob>;
  private readonly worker: Worker<ReminderJob>;

  constructor(config: ConfigService, private prisma: PrismaService, private whatsapp: WhatsappPort) {
    const connection = redisConnection(config.get('REDIS_URL') ?? 'redis://localhost:6379');
    this.queue = new Queue<ReminderJob>(QUEUE_NAME, { connection });
    this.worker = new Worker<ReminderJob>(QUEUE_NAME, (job) => this.deliver(job), { connection });
    this.queue.on('error', (error) => this.logger.error('Site-visit reminder queue error', error.stack));
    this.worker.on('error', (error) => this.logger.error('Site-visit reminder worker error', error.stack));
    this.worker.on('failed', (job, error) => {
      this.logger.error(`Site-visit reminder job ${job?.id ?? 'unknown'} failed`, error.stack);
    });
  }

  async schedule(siteVisitId: string, scheduledAt: Date) {
    const expectedAt = scheduledAt.getTime();
    const threeHourJob = await this.queue.add(
      'reminder',
      { siteVisitId, expectedAt, hoursBefore: 3 },
      { jobId: jobId(siteVisitId, expectedAt, 3), delay: delayUntil(subHours(scheduledAt, 3)) },
    );
    const oneHourJob = await this.queue.add(
      'reminder',
      { siteVisitId, expectedAt, hoursBefore: 1 },
      { jobId: jobId(siteVisitId, expectedAt, 1), delay: delayUntil(subHours(scheduledAt, 1)) },
    );
    if (!oneHourJob.id) throw new Error('BullMQ did not return an ID for the one-hour site-visit reminder');
    return oneHourJob.id;
  }

  async cancel(siteVisitId: string, scheduledAt: Date, reminderJobId?: string | null) {
    const ids = [jobId(siteVisitId, scheduledAt.getTime(), 3), jobId(siteVisitId, scheduledAt.getTime(), 1), reminderJobId]
      .filter((id): id is string => Boolean(id));
    for (const id of new Set(ids)) {
      const job = await this.queue.getJob(id);
      if (job && await job.getState() !== 'active') await job.remove();
    }
  }

  async onModuleDestroy() {
    await Promise.all([this.worker.close(), this.queue.close()]);
  }

  private async deliver(job: Job<ReminderJob>) {
    const visit = await this.prisma.siteVisit.findUnique({
      where: { id: job.data.siteVisitId },
      include: { lead: true },
    });
    if (!visit || visit.status !== 'SCHEDULED' || visit.scheduledAt.getTime() !== job.data.expectedAt) return;

    const consent = await this.prisma.consent.findFirst({
      where: { contactPhone: visit.lead.phone, channel: 'WHATSAPP' },
      orderBy: { createdAt: 'desc' },
      select: { given: true },
    });
    if (!consent?.given) return;
    await this.whatsapp.sendTemplate(visit.lead.phone, `site_visit_reminder_${job.data.hoursBefore}h`, [
      visit.lead.name,
      visit.scheduledAt.toISOString(),
    ]);
  }
}

function jobId(siteVisitId: string, expectedAt: number, hoursBefore: 1 | 3) {
  return `visit-${siteVisitId}-${expectedAt}-${hoursBefore}h`;
}

function delayUntil(at: Date) {
  return Math.max(0, at.getTime() - Date.now());
}

function redisConnection(raw: string) {
  const url = new URL(raw);
  if (!['redis:', 'rediss:'].includes(url.protocol)) throw new Error('REDIS_URL must use redis:// or rediss://');
  const db = url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0;
  if (!Number.isInteger(db) || db < 0) throw new Error('REDIS_URL database path must be a non-negative integer');
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    db,
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
  };
}
