import { ArgumentsHost, CallHandler, Catch, ExceptionFilter, ExecutionContext, HttpException, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Response } from 'express';
import { map, Observable } from 'rxjs';

const CODES: Record<number, string> = {
  400: 'VALIDATION_ERROR', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND',
  409: 'CONFLICT', 422: 'UNPROCESSABLE', 423: 'LOCKED', 429: 'RATE_LIMITED',
};

/** { error: { code, message, ... } } on every failure. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');
  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    let status = 500;
    let body: any = { code: 'INTERNAL_ERROR', message: 'Internal server error' };
    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const r: any = exception.getResponse();
      if (typeof r === 'string') body = { code: CODES[status] ?? 'ERROR', message: r };
      else if (r.code) body = r;
      else if (Array.isArray(r.message)) body = { code: 'VALIDATION_ERROR', message: 'Validation failed', details: r.message };
      else body = { code: CODES[status] ?? 'ERROR', message: r.message };
    } else {
      this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    }
    res.status(status).json({ error: body });
  }
}

/** { data, meta } on every success. Handlers may return { data, meta } themselves. */
@Injectable()
export class EnvelopeInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(
      map((r) => (r && typeof r === 'object' && !Array.isArray(r) && 'data' in r ? r : { data: r })),
    );
  }
}
