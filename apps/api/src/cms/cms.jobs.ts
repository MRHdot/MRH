import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { CmsService } from './cms.service';

@Injectable()
export class CmsJobs {
  constructor(private cms: CmsService) {}

  @Cron('*/5 * * * *')
  publishScheduledContent() {
    return this.cms.publishDueContent();
  }
}