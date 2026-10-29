import { parseCsv, toCsv } from './csv';

describe('CSV helpers', () => {
  it('parses quoted commas, escaped quotes, and embedded newlines', () => {
    expect(parseCsv('name,notes\r\n"Rohan, Mehta","said ""hello""\nagain"')).toEqual([
      ['name', 'notes'],
      ['Rohan, Mehta', 'said "hello"\nagain'],
    ]);
  });

  it('rejects malformed quoted fields', () => {
    expect(() => parseCsv('name,phone\n"Rohan,123')).toThrow('Unclosed quoted CSV field');
  });

  it('writes escaped CSV that can be parsed back', () => {
    const rows = [['name', 'reason'], ['Rohan, Mehta', 'invalid "phone"']];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });
});
