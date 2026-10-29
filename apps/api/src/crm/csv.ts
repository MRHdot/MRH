export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let afterQuote = false;
  const text = input.replace(/^\uFEFF/, '');

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
        afterQuote = true;
      } else {
        field += char;
      }
      continue;
    }

    if (afterQuote && char !== ',' && char !== '\r' && char !== '\n' && !/\s/.test(char)) {
      throw new Error(`Unexpected character after a quoted CSV field at character ${i + 1}`);
    }
    if (char === '"' && field.length === 0 && !afterQuote) {
      quoted = true;
    } else if (char === ',') {
      row.push(field.trim());
      field = '';
      afterQuote = false;
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field.trim());
      rows.push(row);
      row = [];
      field = '';
      afterQuote = false;
    } else {
      field += char;
      afterQuote = false;
    }
  }

  if (quoted) throw new Error('Unclosed quoted CSV field');
  if (row.length || field.length || afterQuote) {
    row.push(field.trim());
    rows.push(row);
  }
  return rows.filter((values) => values.some((value) => value.length > 0));
}

export function toCsv(rows: string[][]): string {
  return rows.map((row) => row.map(escapeCsv).join(',')).join('\r\n');
}

function escapeCsv(value: string) {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
