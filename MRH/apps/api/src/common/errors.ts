import { HttpException } from '@nestjs/common';

/** Throwable with a stable machine-readable code, matching the handbook's error envelope. */
export class AppError extends HttpException {
  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super({ code, message, ...extra }, status);
  }
}
