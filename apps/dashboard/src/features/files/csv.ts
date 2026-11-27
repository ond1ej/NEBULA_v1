// Small RFC 4180 style CSV / TSV parser for previews (quoted fields, "" escapes, CR / LF / CRLF).

export interface CsvResult {
  rows: string[][];
  /** More rows exist than `maxRows`. */
  truncated: boolean;
  /** Widest row (for padding the table). */
  columns: number;
}

/** "\t" for .tsv; otherwise ";" when the first line has more semicolons than commas (European Excel exports). */
export function detectDelimiter(path: string, text: string): string {
  if (path.toLowerCase().endsWith('.tsv')) return '\t';
  const first = text.slice(0, text.search(/\r?\n|$/));
  const count = (ch: string) => first.split(ch).length - 1;
  if (count('\t') > count(',') && count('\t') > count(';')) return '\t';
  return count(';') > count(',') ? ';' : ',';
}

export function parseCsv(text: string, delimiter = ',', maxRows = Number.POSITIVE_INFINITY): CsvResult {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let columns = 0;
  let i = 0;
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // BOM
  const pushRow = () => {
    row.push(field);
    field = '';
    columns = Math.max(columns, row.length);
    rows.push(row);
    row = [];
  };
  while (i < s.length) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      pushRow();
      i += ch === '\r' && s[i + 1] === '\n' ? 2 : 1;
      if (rows.length > maxRows) break;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (rows.length <= maxRows && (field !== '' || row.length > 0)) pushRow();
  const truncated = rows.length > maxRows;
  return { rows: truncated ? rows.slice(0, maxRows) : rows, truncated, columns };
}
