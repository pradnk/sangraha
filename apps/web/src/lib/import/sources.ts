import 'server-only';
import {
  MAX_IMPORT_ROWS,
  finaliseTable,
  parseCsv,
  type SheetTable,
} from '@sangraha/form-engine';
import { readSheet } from './google-sheets';

/**
 * Getting a table out of whatever the organisation has.
 *
 * Three doors into one shape. Which one they came through stops mattering
 * immediately, so inference, the review screen and the import itself never
 * learn about file formats.
 */

/** Refused rather than truncated: a body this size will not survive Vercel. */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

export type ImportSource =
  | { kind: 'csv'; name: string; text: string }
  | { kind: 'xlsx'; name: string; bytes: ArrayBuffer }
  | { kind: 'sheet'; url: string };

export type SourceResult =
  | { ok: true; table: SheetTable; label: string }
  | { ok: false; error: string };

export async function readSource(source: ImportSource): Promise<SourceResult> {
  switch (source.kind) {
    case 'csv':
      return { ok: true, table: parseCsv(source.text), label: source.name };

    case 'xlsx':
      return readWorkbook(source.name, source.bytes);

    case 'sheet':
      return readSheet(source.url);
  }
}

/**
 * Reads the first worksheet of an Excel file.
 *
 * The first sheet only, deliberately. Offering a sheet picker would mean
 * parsing every sheet in a workbook to name them, and an organisation's export
 * almost always has one — the ones that do not are usually a data sheet plus a
 * "Sheet2" nobody has touched since 2019.
 *
 * Cells are read as their *displayed* text rather than their underlying value,
 * because that is what the person looking at the spreadsheet believes is there.
 * A date formatted as `02/01/2026` should import as that date, not as the
 * serial number Excel keeps underneath.
 */
async function readWorkbook(name: string, bytes: ArrayBuffer): Promise<SourceResult> {
  // Imported here rather than at the top of the file: it is a large dependency
  // used by one route, and pulling it into every server bundle would slow every
  // cold start for the sake of an occasional migration.
  const ExcelJS = (await import('exceljs')).default;

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(bytes as never);
  } catch {
    return {
      ok: false,
      error: 'That file could not be opened as a spreadsheet. Try saving it again as .xlsx or .csv.',
    };
  }

  const sheet = workbook.worksheets[0];
  if (!sheet) return { ok: false, error: 'That workbook has no sheets in it.' };

  const grid: string[][] = [];
  let truncated = false;

  sheet.eachRow({ includeEmpty: false }, (row) => {
    if (grid.length > MAX_IMPORT_ROWS + 1) {
      truncated = true;
      return;
    }
    const cells: string[] = [];
    // `cellCount` rather than the values array, so a gap in the middle of a row
    // stays a gap instead of shifting every later column left by one.
    for (let i = 1; i <= row.cellCount; i += 1) {
      cells.push(cellText(row.getCell(i)));
    }
    grid.push(cells);
  });

  return { ok: true, table: finaliseTable(grid, truncated), label: name };
}

/** What the cell looks like on screen, whatever Excel keeps underneath. */
function cellText(cell: { value: unknown; text?: string }): string {
  const value = cell.value;

  if (value === null || value === undefined) return '';

  if (value instanceof Date) {
    // Excel has no timezone, so the parts as written are the truth. Building
    // the string by hand avoids `toISOString` shifting a birth date back a day.
    const pad = (n: number) => String(n).padStart(2, '0');
    const date = `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
    const hasTime = value.getHours() || value.getMinutes() || value.getSeconds();
    return hasTime ? `${date}T${pad(value.getHours())}:${pad(value.getMinutes())}` : date;
  }

  if (typeof value === 'object') {
    const rich = value as { richText?: { text: string }[]; result?: unknown; text?: string };
    if (rich.richText) return rich.richText.map((part) => part.text).join('');
    // A formula cell: the answer is what the sheet shows, not the formula.
    if (rich.result !== undefined && rich.result !== null) return String(rich.result);
    if (typeof rich.text === 'string') return rich.text;
    return cell.text ?? '';
  }

  return String(value);
}
