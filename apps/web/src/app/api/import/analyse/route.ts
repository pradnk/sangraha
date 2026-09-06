import { NextResponse } from 'next/server';
import { findDuplicateRows, inferTable } from '@sangraha/form-engine';
import { requireRole } from '@/lib/auth/guard';
import { readImportRequest } from '@/lib/import/read-request';

/**
 * Step one: read the spreadsheet and say what is in it.
 *
 * Writes nothing. Everything an administrator needs to judge the import comes
 * back from here — the guesses, the evidence behind them, and every awkwardness
 * found — so the decision to commit is made with the file already understood
 * rather than hoped about.
 */
export async function POST(request: Request) {
  await requireRole(['org_admin', 'super_admin']);

  const result = await readImportRequest(request);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

  if (result.problems.length > 0) {
    return NextResponse.json({ problems: result.problems }, { status: 422 });
  }

  return NextResponse.json({
    label: result.label,
    rowCount: result.table.rows.length,
    truncated: result.table.truncated,
    duplicateRows: findDuplicateRows(result.table),
    columns: inferTable(result.table),
  });
}
