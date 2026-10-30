import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const CRM_AGENT = ['leads.create', 'leads.read', 'leads.update', 'leads.status', 'leads.reactivate', 'leads.delete', 'activities.create', 'visits.manage', 'deals.manage', 'pipeline.read', 'leaderboard.read'];
const CMS_EDITOR = ['content.read', 'content.write', 'content.publish', 'redirects.manage', 'media.manage', 'projects.seo.read', 'projects.seo.write'];
const ROLES: Record<string, string[]> = {
  super_admin: ['*'],
  sales_manager: [...CRM_AGENT, 'leads.assign', 'leads.bulk_import', 'deals.extend_hold', 'projects.seo.read', 'projects.seo.write'],
  sales_agent: CRM_AGENT,
  hr_manager: [], finance_manager: [], content_editor: CMS_EDITOR,
  channel_partner: ['leads.create', 'leads.read'],
  client: [],
};

async function main() {
  for (const [name, permissions] of Object.entries(ROLES)) {
    await prisma.role.upsert({ where: { name }, update: { permissions }, create: { name, permissions } });
  }
  const role = async (name: string) => (await prisma.role.findUniqueOrThrow({ where: { name } })).id;
  const mkUser = async (email: string, name: string, roleName: string, password: string) =>
    prisma.user.upsert({
      where: { email }, update: {},
      create: { email, name, roleId: await role(roleName), passwordHash: await bcrypt.hash(password, 10) },
    });

  const adminPw = process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMe123!';
  await mkUser(process.env.SEED_ADMIN_EMAIL ?? 'admin@myroofhomes.com', 'Super Admin', 'super_admin', adminPw);

  if (process.env.NODE_ENV !== 'production') {
    await mkUser('manager@myroofhomes.com', 'Mira Manager', 'sales_manager', 'ChangeMe123!');
    const a1 = await mkUser('agent1@myroofhomes.com', 'Arjun Agent', 'sales_agent', 'ChangeMe123!');
    await mkUser('agent2@myroofhomes.com', 'Sana Agent', 'sales_agent', 'ChangeMe123!');
    if ((await prisma.lead.count()) === 0) {
      await prisma.lead.createMany({ data: [
        { name: 'Priya Sharma', phone: '9820011223', source: 'PORTAL_99ACRES' },
        { name: 'Amit Kulkarni', phone: '9820011224', source: 'WEBSITE', status: 'CONTACTED', assignedTo: a1.id },
        { name: 'Sana Sheikh', phone: '9820011225', source: 'REFERRAL', status: 'QUALIFIED', assignedTo: a1.id, budgetMin: 7000000, budgetMax: 9500000, projectInterest: '2BHK in Powai' },
      ] });
    }
  }
  await prisma.systemSetting.upsert({ where: { key: 'crm.sla.firstResponseMinutes' }, update: {}, create: { key: 'crm.sla.firstResponseMinutes', value: 30 } });
  console.log('Seed complete');
}
main().finally(() => prisma.$disconnect());
