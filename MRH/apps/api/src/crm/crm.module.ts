import { Module } from '@nestjs/common';
import { AssignmentService } from './assignment.service';
import { CrmController } from './crm.controller';
import { DealsService } from './deals.service';
import { CrmJobs } from './jobs';
import { LeadStateMachineService } from './lead-state-machine.service';
import { LeadsService } from './leads.service';
import { CrmListeners } from './listeners';
import { SiteVisitsService } from './site-visits.service';

@Module({
  controllers: [CrmController],
  providers: [LeadsService, LeadStateMachineService, AssignmentService, SiteVisitsService, DealsService, CrmJobs, CrmListeners],
  exports: [LeadsService, DealsService],
})
export class CrmModule {}
