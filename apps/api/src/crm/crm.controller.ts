import { BadRequestException, Body, Controller, Delete, Get, Headers, Ip, Param, Patch, Post, Query, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthUser, CurrentUser, Public, RequirePermission } from '../auth/auth.types';
import { LeadIntakeGuard } from '../auth/guards';
import { AppError } from '../common/errors';
import { RateLimit, RateLimitGuard } from '../common/rate-limit.guard';
import * as D from './dto';
import { DealsService } from './deals.service';
import { LeadsService } from './leads.service';
import { SiteVisitsService } from './site-visits.service';

@Controller()
export class CrmController {
  constructor(private leads: LeadsService, private visits: SiteVisitsService, private deals: DealsService) {}

  // ── Leads ──
  @Public() @RateLimit(60, 60_000) @UseGuards(RateLimitGuard, LeadIntakeGuard) @Post('leads')
  create(@Body() dto: D.CreateLeadDto, @CurrentUser() u: AuthUser, @Ip() ip: string) { return this.leads.createLead(dto, u, ip); }

  @RequirePermission('leads.bulk_import')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024, files: 1 } }))
  @Post('leads/bulk-import')
  bulkImport(@UploadedFile() file: { buffer: Buffer } | undefined, @CurrentUser() u: AuthUser, @Ip() ip: string) {
    if (!file?.buffer) throw new BadRequestException('CSV file is required in the "file" field');
    return this.leads.bulkImport(file.buffer, u, ip);
  }

  @RequirePermission('leads.read') @Get('leads')
  list(@Query() q: D.ListLeadsQuery, @CurrentUser() u: AuthUser) { return this.leads.list(q, u); }

  @RequirePermission('leads.read') @Get('leads/:id')
  detail(@Param('id') id: string, @CurrentUser() u: AuthUser) { return this.leads.getDetail(id, u); }

  @RequirePermission('leads.update') @Patch('leads/:id')
  update(@Param('id') id: string, @Body() dto: D.UpdateLeadDto, @Headers('if-match') ifMatch: string, @CurrentUser() u: AuthUser) {
    const version = parseInt((ifMatch ?? '').replace(/"/g, ''), 10);
    if (Number.isNaN(version)) throw new AppError(400, 'VALIDATION_ERROR', 'If-Match header with the lead version is required');
    return this.leads.update(id, dto, version, u);
  }
  @RequirePermission('leads.status') @Patch('leads/:id/status')
  status(@Param('id') id: string, @Body() dto: D.ChangeStatusDto, @CurrentUser() u: AuthUser) { return this.leads.changeStatus(id, dto, u); }

  @RequirePermission('leads.assign') @Post('leads/:id/assign')
  assign(@Param('id') id: string, @Body() dto: D.AssignDto, @CurrentUser() u: AuthUser) { return this.leads.assign(id, dto, u); }

  @RequirePermission('leads.assign') @Post('leads/reassign-agent')
  reassignAgent(@Body() dto: D.BulkReassignDto, @CurrentUser() u: AuthUser) { return this.leads.reassignAgent(dto, u); }

  @RequirePermission('leads.reactivate') @Post('leads/:id/reactivate')
  reactivate(@Param('id') id: string, @Body() dto: D.ReactivateDto, @CurrentUser() u: AuthUser) { return this.leads.reactivate(id, dto.notes, u); }

  @RequirePermission('leads.delete') @Delete('leads/:id')
  remove(@Param('id') id: string, @CurrentUser() u: AuthUser) { return this.leads.remove(id, u); }

  // ── Activities ──
  @RequirePermission('activities.create') @Post('leads/:id/activities')
  addActivity(@Param('id') id: string, @Body() dto: D.CreateActivityDto, @CurrentUser() u: AuthUser) { return this.leads.addActivity(id, dto, u); }

  @RequirePermission('leads.read') @Get('leads/:id/activities')
  activities(@Param('id') id: string, @Query() q: D.ListActivitiesQuery, @CurrentUser() u: AuthUser) { return this.leads.listActivities(id, u, q); }

  // ── Pipeline ──
  @RequirePermission('pipeline.read') @Get('pipeline')
  pipeline(@Query() q: D.PipelineQuery, @CurrentUser() u: AuthUser) { return this.leads.pipeline(q, u); }

  @RequirePermission('leaderboard.read') @Get('leaderboard')
  leaderboard(@Query() q: D.LeaderboardQuery) { return this.leads.leaderboard(q); }

  // ── Site visits ──
  @RequirePermission('visits.manage') @Post('site-visits')
  createVisit(@Body() dto: D.CreateVisitDto, @CurrentUser() u: AuthUser) { return this.visits.create(dto, u); }

  @RequirePermission('visits.manage') @Get('site-visits')
  listVisits(@Query() q: D.ListVisitsQuery, @CurrentUser() u: AuthUser) { return this.visits.list(q, u); }

  @RequirePermission('visits.manage') @Patch('site-visits/:id')
  updateVisit(@Param('id') id: string, @Body() dto: D.UpdateVisitDto, @CurrentUser() u: AuthUser) { return this.visits.update(id, dto, u); }

  // ── Deals ──
  @RequirePermission('deals.manage') @Post('deals')
  createDeal(@Body() dto: D.CreateDealDto, @CurrentUser() u: AuthUser) { return this.deals.create(dto, u); }

  @RequirePermission('deals.manage') @Get('deals/:id')
  getDeal(@Param('id') id: string, @CurrentUser() u: AuthUser) { return this.deals.get(id, u); }

  @RequirePermission('deals.manage') @Patch('deals/:id')
  updateDeal(@Param('id') id: string, @Body() dto: D.UpdateDealDto, @CurrentUser() u: AuthUser) { return this.deals.update(id, dto, u); }

  @RequirePermission('deals.manage') @Patch('deals/:id/stage')
  dealStage(@Param('id') id: string, @Body() dto: D.DealStageDto, @CurrentUser() u: AuthUser) { return this.deals.updateStage(id, dto, u); }

  @RequirePermission('deals.extend_hold') @Patch('deals/:id/extend-hold')
  extend(@Param('id') id: string, @Body() dto: D.ExtendHoldDto, @CurrentUser() u: AuthUser) { return this.deals.extendHold(id, dto.additionalHours, u); }
}
