/**
 * A spreadsheet, once it has been read.
 *
 * Everything downstream — inference, validation, the review screen, the import
 * itself — works on this shape, so a CSV, an Excel file and a Google Sheet stop
 * being different things after the first step.
 */

export interface SheetTable {
  /** Column headings, in order, exactly as written. */
  headers: string[];
  /** Data rows. Short rows are padded so every row has one cell per header. */
  rows: string[][];
  /** Rows read before the cap was hit, when a file was longer than allowed. */
  truncated: boolean;
}

/** Reasons a file cannot be read at all, as opposed to merely being messy. */
export type TableProblem =
  | { kind: 'empty' }
  | { kind: 'no_headers' }
  | { kind: 'blank_header'; column: number }
  | { kind: 'duplicate_header'; header: string };

export const MAX_IMPORT_ROWS = 5_000;

/**
 * Reads CSV to RFC 4180: quoted fields, doubled quotes, embedded newlines.
 *
 * Hand-written rather than pulled in, for the same reason `csv.ts` writes it by
 * hand — this is a hundred lines of well-specified behaviour, it is the format
 * every NGO's spreadsheet exports to, and a dependency here would be a
 * dependency in the path of everybody's data migration.
 *
 * Tolerant on the way in where the spec is silent: a lone `\r` or `\n` both end
 * a row, and a trailing newline does not produce a phantom empty row.
 */
export function parseCsv(text: string, maxRows = MAX_IMPORT_ROWS): SheetTable {
  // Excel and Google Sheets both write a BOM. Left in place it becomes part of
  // the first heading, so `Name` silently stops matching `Name`.
  const input = text.replace(/^﻿/, '');

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let sawAnyChar = false;
  let truncated = false;

  const endField = () => {
    row.push(field);
    field = '';
  };

  const endRow = () => {
    endField();
    // A row of nothing but empty cells is a blank line, not a record.
    if (row.some((cell) => cell.trim() !== '')) rows.push(row);
    row = [];
    sawAnyChar = false;
  };

  for (let i = 0; i < input.length; i += 1) {
    if (rows.length > maxRows) {
      truncated = true;
      break;
    }

    const char = input[i]!;

    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && field === '') {
      quoted = true;
      sawAnyChar = true;
    } else if (char === ',') {
      endField();
      sawAnyChar = true;
    } else if (char === '\r' || char === '\n') {
      if (char === '\r' && input[i + 1] === '\n') i += 1;
      endRow();
    } else {
      field += char;
      sawAnyChar = true;
    }
  }

  if (!truncated && (sawAnyChar || field !== '' || row.length > 0)) endRow();

  return finaliseTable(rows, truncated, maxRows);
}

/** Squares off a raw grid: first row becomes headers, the rest are padded. */
export function finaliseTable(
  grid: string[][],
  truncated: boolean,
  maxRows = MAX_IMPORT_ROWS,
): SheetTable {
  if (grid.length === 0) return { headers: [], rows: [], truncated };

  const headers = (grid[0] ?? []).map((cell) => cell.trim());
  const width = headers.length;

  const rows = grid.slice(1, maxRows + 1).map((line) => {
    const padded = line.slice(0, width).map((cell) => cell.trim());
    while (padded.length < width) padded.push('');
    return padded;
  });

  return { headers, rows, truncated: truncated || grid.length - 1 > maxRows };
}

/**
 * Whether the table can be worked with at all.
 *
 * Separate from the column-by-column warnings: these are things the admin has
 * to go and fix in the spreadsheet, not judgements they can accept or override.
 * A blank heading is the common one — a stray column at the right-hand edge of
 * a sheet somebody has been editing for years.
 */
export function checkTable(table: SheetTable): TableProblem[] {
  if (table.headers.length === 0) return [{ kind: 'no_headers' }];
  if (table.rows.length === 0) return [{ kind: 'empty' }];

  const problems: TableProblem[] = [];
  const seen = new Map<string, number>();

  table.headers.forEach((header, index) => {
    if (header === '') {
      problems.push({ kind: 'blank_header', column: index });
      return;
    }
    const key = header.toLowerCase();
    seen.set(key, (seen.get(key) ?? 0) + 1);
  });

  for (const [header, count] of seen) {
    // Two columns with one name would become two questions with one key, and
    // the second would silently overwrite the first.
    if (count > 1) problems.push({ kind: 'duplicate_header', header });
  }

  return problems;
}

/** The values in one column, with blanks kept so they can be counted. */
export function column(table: SheetTable, index: number): string[] {
  return table.rows.map((row) => row[index] ?? '');
}
