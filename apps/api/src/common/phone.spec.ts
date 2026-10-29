import { normalizePhone } from './phone';

describe('normalizePhone', () => {
  it('strips +91, spaces, hyphens, brackets', () => {
    expect(normalizePhone('+91 98765 43210')).toBe('9876543210');
    expect(normalizePhone('(98765)-43210')).toBe('9876543210');
    expect(normalizePhone('919876543210')).toBe('9876543210');
  });
  it('preserves local numbers that begin with 91', () => {
    expect(normalizePhone('9123456789')).toBe('9123456789');
  });
  it('rejects anything not resolving to 10 digits', () => {
    expect(() => normalizePhone('12345')).toThrow();
    expect(() => normalizePhone('abcdefghij')).toThrow();
  });
});
