import { BadRequestException } from '@nestjs/common';

/** Digits only, no +91; must resolve to exactly 10 digits. The ONLY phone format stored anywhere. */
export function normalizePhone(raw: string): string {
  const digits = (raw ?? '').replace(/[\s\-()]/g, '').replace(/^\+?91/, '');
  if (!/^\d{10}$/.test(digits)) throw new BadRequestException('Phone number must resolve to 10 digits');
  return digits;
}
