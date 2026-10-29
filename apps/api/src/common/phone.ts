import { BadRequestException } from '@nestjs/common';

/** Digits only, no +91; must resolve to exactly 10 digits. The ONLY phone format stored anywhere. */
export function normalizePhone(raw: string): string {
  const cleaned = (raw ?? '').replace(/[\s\-()]/g, '');
  const digits = cleaned.length > 10 && /^\+?91/.test(cleaned) ? cleaned.replace(/^\+?91/, '') : cleaned;
  if (!/^\d{10}$/.test(digits)) throw new BadRequestException('Phone number must resolve to 10 digits');
  return digits;
}
