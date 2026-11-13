import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser, RequirePermission } from '../auth/auth.types';
import { InventoryService } from './inventory.service';

// The application applies the global `v1` prefix in main.ts.
@Controller()
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @RequirePermission('inventory:project:write')
  @Post('projects')
  createProject(@Body() body: any) {
    return this.inventory.createProject(body);
  }

  @RequirePermission('inventory:read')
  @Get('projects')
  listProjects() {
    return this.inventory.listProjects();
  }

  @RequirePermission('inventory:read')
  @Get('projects/:id')
  getProject(@Param('id') id: string) {
    return this.inventory.getProject(id);
  }

  @RequirePermission('inventory:project:write')
  @Patch('projects/:id')
  updateProject(@Param('id') id: string, @Body() body: any) {
    return this.inventory.updateProject(id, body);
  }

  @RequirePermission('inventory:project:write')
  @Patch('projects/:id/status')
  updateProjectStatus(@Param('id') id: string, @Body() body: any) {
    return this.inventory.updateProjectStatus(id, body.status);
  }

  @RequirePermission('inventory:rera:read')
  @Get('projects/:id/rera-status')
  getProjectReraStatus(@Param('id') id: string) {
    return this.inventory.getProjectReraStatus(id);
  }

  @RequirePermission('inventory:rera:read')
  @Get('compliance/dashboard')
  getComplianceDashboard() {
    return this.inventory.getComplianceDashboard();
  }

  @RequirePermission('inventory:unit:write')
  @Post('units')
  createUnit(@Body() body: any) {
    return this.inventory.createUnit(body);
  }

  @RequirePermission('inventory:read')
  @Get('units')
  listUnits(@Query() query: any) {
    return this.inventory.listUnits(query);
  }

  @RequirePermission('inventory:read')
  @Get('units/heatmap')
  getHeatmap(@Query('project') projectId?: string) {
    return this.inventory.getHeatmap(projectId);
  }

  @RequirePermission('inventory:read')
  @Get('units/:id')
  getUnit(@Param('id') id: string) {
    return this.inventory.getUnit(id);
  }

  @RequirePermission('inventory:unit:write')
  @Patch('units/:id')
  updateUnit(@Param('id') id: string, @Body() body: any) {
    return this.inventory.updateUnit(id, body);
  }

  @RequirePermission('inventory:price:update')
  @Post('units/:id/price')
  updatePrice(
    @Param('id') id: string,
    @Body() body: { newPrice: number; reason?: string },
    @CurrentUser() user: AuthUser,
  ) {
    return this.inventory.updatePrice(id, body.newPrice, body.reason, user.id);
  }

  @RequirePermission('inventory:unit:block')
  @Post('units/:id/block')
  blockUnit(@Param('id') id: string, @Body() body: { reason: string }) {
    return this.inventory.blockUnitById(id, body.reason);
  }

  @RequirePermission('inventory:unit:block')
  @Post('units/:id/unblock')
  unblockUnit(@Param('id') id: string) {
    return this.inventory.unblockUnitById(id);
  }
}
