import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { addHours } from 'date-fns';
import { Tx } from '../prisma/prisma.module';

/**
 * Ports to modules that are built LATER in the plan. CRM codes against these abstract
 * classes; each stub below is swapped for the real provider when its module lands
 * (no CRM changes needed). See the CRM handbook's "Sequencing note".
 */
export abstract class InventoryPort {            // Module 02
  abstract holdUnitForDeal(tx: Tx, unitId: string, dealId: string): Promise<Date>;
  abstract extendHold(tx: Tx, unitId: string, until: Date): Promise<void>;
  abstract releaseUnit(tx: Tx, unitId: string): Promise<void>;
  abstract markUnitSold(tx: Tx, unitId: string): Promise<void>;
}
export abstract class WhatsappPort {              // Module 04
  abstract sendTemplate(phone: string, template: string, params: string[]): Promise<void>;
  abstract notifyUser(userId: string, message: string): Promise<void>;
  abstract notifyRole(role: string, message: string): Promise<void>;
}
export abstract class AgentAvailabilityPort {     // Module 05 (HRMS leave)
  abstract getUnavailableAgentIds(at: Date): Promise<string[]>;
}
export abstract class InvoiceLockPort {           // Module 06 (Finance)
  abstract hasActiveInvoice(dealId: string): Promise<boolean>;
}

@Injectable() class StubInventory extends InventoryPort {
  private log = new Logger('InventoryStub');
  async holdUnitForDeal(_tx: Tx, unitId: string) { this.log.debug(`hold ${unitId}`); return addHours(new Date(), 48); }
  async extendHold() {}
  async releaseUnit(_tx: Tx, unitId: string) { this.log.debug(`release ${unitId}`); }
  async markUnitSold(_tx: Tx, unitId: string) { this.log.debug(`sold ${unitId}`); }
}
@Injectable() class StubWhatsapp extends WhatsappPort {
  private log = new Logger('WhatsappStub');
  async sendTemplate(phone: string, t: string, p: string[]) { this.log.log(`template ${t} -> ${phone} ${JSON.stringify(p)}`); }
  async notifyUser(id: string, m: string) { this.log.log(`notify user ${id}: ${m}`); }
  async notifyRole(r: string, m: string) { this.log.log(`notify role ${r}: ${m}`); }
}
@Injectable() class StubAvailability extends AgentAvailabilityPort { async getUnavailableAgentIds() { return []; } }
@Injectable() class StubInvoiceLock extends InvoiceLockPort { async hasActiveInvoice() { return false; } }

@Global()
@Module({
  providers: [
    { provide: InventoryPort, useClass: StubInventory },
    { provide: WhatsappPort, useClass: StubWhatsapp },
    { provide: AgentAvailabilityPort, useClass: StubAvailability },
    { provide: InvoiceLockPort, useClass: StubInvoiceLock },
  ],
  exports: [InventoryPort, WhatsappPort, AgentAvailabilityPort, InvoiceLockPort],
})
export class IntegrationsModule {}
