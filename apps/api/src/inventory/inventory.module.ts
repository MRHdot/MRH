import { Module } from '@nestjs/common';
import { InventoryPort, ProjectCatalogPort } from '../integrations/ports';
import { PrismaModule } from '../prisma/prisma.module';
import { InventoryController } from './inventory.controller';
import { InventoryJobs } from './inventory.jobs';
import { InventoryService } from './inventory.service';

@Module({
  imports: [PrismaModule],
  controllers: [InventoryController],
  providers: [
    InventoryService,
    InventoryJobs,
    { provide: InventoryPort, useExisting: InventoryService },
    { provide: ProjectCatalogPort, useExisting: InventoryService },
  ],
  exports: [InventoryService, InventoryPort, ProjectCatalogPort],
})
export class InventoryModule {}
