import 'server-only';
import { checkTable, type SheetTable, type TableProblem } from '@sangraha/form-engine';
import { MAX_IMPORT_BYTES, readSource, type ImportSource } from './sources';

/**
 * Getting the table out of a request, the same way for both steps.
 *
 * The file is sent twice — once to analyse, once to commit — rather than being
 * held on the server between them. That costs a second parse and saves a whole
 * category of problem: no temporary storage to secure, nothing to expire, and
 * no chance of an admin confirming against a table that has since been evicted.
 * At five megabytes the parse is cheap and the upload is the slow part either
 * way.
 */

export type ReadResult =
  | { ok: true; table: SheetTable; label: string; problems: TableProblem[] }
  | { ok: false; error: string };

export async function readImportRequest(request: Request): Promise<ReadResult> {
  const contentType = request.headers.get('content-type') ?? '';

  let source: ImportSource;

  if (contentType.includes('application/json')) {
    const body = (await request.json().catch(() => null)) as { sheetUrl?: string } | null;
    if (!body?.sheetUrl?.trim()) return { ok: false, error: 'Paste a Google Sheets link.' };
    source = { kind: 'sheet', url: body.sheetUrl };
  } else {
    const form = await request.formData().catch(() => null);
    const file = form?.get('file');

    if (!(file instanceof File)) return { ok: false, error: 'Choose a file to upload.' };

    if (file.size > MAX_IMPORT_BYTES) {
      return {
        ok: false,
        error: `That file is ${Math.round(file.size / 1024 / 1024)} MB. The limit is 5 MB — split it into a few smaller files and import them one after another.`,
      };
    }

    const name = file.name.toLowerCase();
    if (name.endsWith('.csv') || name.endsWith('.txt')) {
      source = { kind: 'csv', name: file.name, text: await file.text() };
    } else if (name.endsWith('.xlsx') || name.endsWith('.xlsm')) {
      source = { kind: 'xlsx', name: file.name, bytes: await file.arrayBuffer() };
    } else if (name.endsWith('.xls')) {
      return {
        ok: false,
        error:
          'That is the old Excel format. Open it and choose Save As → Excel Workbook (.xlsx), or export it as CSV.',
      };
    } else {
      return { ok: false, error: 'Upload a .csv or .xlsx file, or paste a Google Sheets link.' };
    }
  }

  const result = await readSource(source);
  if (!result.ok) return result;

  return {
    ok: true,
    table: result.table,
    label: result.label,
    problems: checkTable(result.table),
  };
}
