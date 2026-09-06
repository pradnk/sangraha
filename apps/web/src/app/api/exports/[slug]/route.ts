import { NextResponse } from 'next/server';
import {
  UTF8_BOM,
  countRecords,
  csvRow,
  getOwnerDb,
  getRecordView,
  listRecordColumns,
  streamRecords,
} from '@sangraha/db';
import { requireRole, withSession } from '@/lib/auth/guard';
import { logAccess, scopeOf } from '@/lib/access-log';
import { filtersFromParams } from '@/lib/records-filters';

/**
 * Downloads the records an admin is looking at.
 *
 * Runs the same filters as the screen, so what lands in the spreadsheet is
 * exactly what was on the page — an export that quietly differs from the table
 * above it is how a report ends up defended with the wrong numbers.
 *
 * `org_admin` only. The analytics views run with owner rights and so return the
 * whole organisation; see `records.ts`.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const session = await requireRole(['org_admin', 'super_admin']);
  const { slug } = await params;

  // Resolved through the request connection, under RLS, so a slug from another
  // organisation resolves to nothing before any owner-rights query runs.
  const view = await withSession(session, (tx) => getRecordView(tx, session.orgId, slug));
  if (!view) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const db = getOwnerDb();
  const columns = await listRecordColumns(db, view);
  const search = new URL(request.url).searchParams;
  const filters = filtersFromParams(search);

  /*
   * Logged before a byte is streamed, and counted rather than named.
   *
   * Once this file exists it is on a laptop, in an inbox, on a funder's drive —
   * it cannot be recalled. The most that can ever be said about it afterwards
   * is who took it, when, under which filters, and how many people were in it.
   * Counting costs an extra aggregate; not counting means a breach report that
   * says "some records".
   */
  const { total } = await countRecords(db, view, filters);
  await logAccess(session, {
    action: 'export_csv',
    targetType: 'form',
    targetId: view.formId,
    rowCount: total,
    scope: scopeOf(search),
  });

  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        /*
         * The byte-order mark goes first, before anything else. Without it
         * Excel on Windows reads the file in the system codepage and every
         * Hindi and Kannada name in it becomes mojibake — which for this
         * product is not a cosmetic problem.
         */
        controller.enqueue(encoder.encode(UTF8_BOM));
        controller.enqueue(encoder.encode(csvRow(columns.map((column) => column.name))));

        for await (const batch of streamRecords(db, view, filters)) {
          for (const row of batch) {
            controller.enqueue(encoder.encode(csvRow(columns.map((c) => row[c.name]))));
          }
        }
      } catch (error) {
        controller.error(error);
        return;
      }
      controller.close();
    },
  });

  return new Response(body, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${slug}-${today()}.csv"`,
      // Beneficiary data. Never let a proxy or the browser keep a copy.
      'cache-control': 'no-store, private',
    },
  });
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
