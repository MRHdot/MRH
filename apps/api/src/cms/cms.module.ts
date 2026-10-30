import { Module } from '@nestjs/common';
import { CmsController } from './cms.controller';
import { CmsJobs } from './cms.jobs';
import { CmsListeners } from './cms.listeners';
import { CmsService } from './cms.service';
import { RevalidationService } from './revalidation.service';

@Module({
  controllers: [CmsController],
  providers: [CmsService, CmsListeners, CmsJobs, RevalidationService],
  exports: [CmsService],
})
export class CmsModule {}