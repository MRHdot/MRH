import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { InventoryService } from './inventory.service';

@Controller('v1')
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Post('projects')
  createProject(@Body() body: any) {
    return this.inventory.createProject(body);
  }

  @Get('projects')
  listProjects() {
    return this.inventory.listProjects();
  }

  @Get('projects/:id')
  getProject(@Param('id') id: string) {
    return this.inventory.getProject(id);
  }

  @Patch('projects/:id')
  updateProject(@Param('id') id: string, @Body() body: any) {
    return this.inventory.updateProject(id, body);
  }

  @Patch('projects/:id/status')
  updateProjectStatus(@Param('id') id: string, @Body() body: any) {
    return this.inventory.updateProjectStatus(id, body.status);
  }

  @Get('projects/:id/rera-status')
  getProjectReraStatus(@Param('id') id: string) {
    return this.inventory.getProjectReraStatus(id);
  }

  @Get('compliance/dashboard')
  getComplianceDashboard() {
    return this.inventory.getComplianceDashboard();
  }

  @Post('units')
  createUnit(@Body() body: any) {
    return this.inventory.createUnit(body);
  }

  @Get('units')
  listUnits(@Query() query: any) {
    return this.inventory.listUnits(query);
  }

  @Get('units/heatmap')
  getHeatmap(@Query('project') projectId?: string) {
    return this.inventory.getHeatmap(projectId);
  }

  @Get('units/:id')
  getUnit(@Param('id') id: string) {
    return this.inventory.getUnit(id);
  }

  @Patch('units/:id')
  updateUnit(@Param('id') id: string, @Body() body: any) {
    return this.inventory.updateUnit(id, body);
  }

  @Post('units/:id/price')
  updatePrice(@Param('id') id: string, @Body() body: any) {
    return this.inventory.updatePrice(id, body.newPrice, body.reason, body.actorId ?? 'system');
  }

  @Post('units/:id/block')
  blockUnit(@Param('id') id: string, @Body() body: any) {
    return this.inventory.blockUnitById(id, body.reason);
  }

  @Post('units/:id/unblock')
  unblockUnit(@Param('id') id: string) {
    return this.inventory.unblockUnitById(id);
  }
}
