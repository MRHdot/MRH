import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class RevalidationService {
  private readonly logger = new Logger(RevalidationService.name);

  constructor(private config: ConfigService) {}

  async revalidate(path: string) {
    const baseUrl = this.config.get<string>('WEB_APP_URL');
    const secret = this.config.get<string>('REVALIDATE_SECRET');
    if (!baseUrl || !secret) {
      this.logger.debug(`Web revalidation is not configured for ${path}`);
      return;
    }
    try {
      const response = await fetch(new URL('/api/revalidate', baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-revalidate-secret': secret },
        body: JSON.stringify({ path }),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) this.logger.warn(`Web revalidation failed for ${path}: ${response.status}`);
    } catch (error) {
      this.logger.warn(`Web revalidation failed for ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}