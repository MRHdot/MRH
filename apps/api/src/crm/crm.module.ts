import { Module } from '@nestjs/common';
import { AssignmentService } from './assignment.service';
import { CrmController } from './crm.controller';
import { DealsService } from './deals.service';
import { CrmJobs } from './jobs';
import { LeadStateMachineService } from './lead-state-machine.service';
import { LeadsService } from './leads.service';
import { CrmListeners } from './listeners';
import { SiteVisitsService } from './site-visits.service';
import { VisitReminderQueueService } from './visit-reminder-queue.service';
import { RateLimitGuard } from '../common/rate-limit.guard';
import { InventoryModule } from '../inventory/inventory.module';

@Module({
  imports: [InventoryModule],
  controllers: [CrmController],
  providers: [LeadsService, LeadStateMachineService, AssignmentService, SiteVisitsService, VisitReminderQueueService, DealsService, CrmJobs, CrmListeners, RateLimitGuard],
  exports: [LeadsService, DealsService],
})
export class CrmModule {}
