import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOwnerDb, importTable, regenerateFormViews } from '@sangraha/db';
import { TEXT_FORMATS } from '@sangraha/form-engine';
import { requireRole, withSession } from '@/lib/auth/guard';
import { readImportRequest } from '@/lib/import/read-request';

/**
 * Step two: create the form and bring the records in.
 *
 * The file is sent again rather than held between steps, and re-read here — so
 * what is imported is what the administrator confirmed, parsed by the same code
 * that produced the guesses they were shown.
 */

const planSchema = z.object({
  formName: z.string().trim().min(2).max(120),
  formType: z.enum(['registration', 'standalone']),
  subjectTypeId: z.string().uuid().nullish(),
  displayNameColumns: z.array(z.string()).default([]),
  columns: z
    .array(
      z.object({
        header: z.string(),
        dataType: z.string(),
        // Nullish rather than optional: the browser omits these, but anything
        // else building a plan will send an explicit null, and refusing that
        // with "something went wrong" would be a dead end.
        format: z.string().nullish(),
        choices: z.array(z.string()).nullish(),
        isRequired: z.boolean(),
        isUnique: z.boolean(),
        include: z.boolean(),
      }),
    )
    .min(1),
});

/**
 * The plan, out of whichever body shape the source used.
 *
 * A file is re-sent as multipart with the plan as a JSON string field; a Google
 * Sheets link is JSON with the plan as an object beside it. Reading only the
 * multipart form meant the sheet path could never commit — the review screen
 * worked all the way to the last button and then returned a bare 400.
 */
async function readPlan(request: Request): Promise<unknown> {
  if ((request.headers.get('content-type') ?? '').includes('application/json')) {
    const body = (await request.clone().json().catch(() => null)) as { plan?: unknown } | null;
    return body?.plan ?? null;
  }

  const form = await request.clone().formData().catch(() => null);
  const raw = form?.get('plan');
  if (typeof raw !== 'string') return null;
  // Not trusted to parse: a truncated upload is a malformed string, and an
  // unhandled throw here would be a 500 for what is really a bad request.
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  const session = await requireRole(['org_admin', 'super_admin']);

  const parsed = planSchema.safeParse(await readPlan(request));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Something went wrong. Please start again.' }, { status: 400 });
  }

  const read = await readImportRequest(request);
  if (!read.ok) return NextResponse.json({ error: read.error }, { status: 400 });
  if (read.problems.length > 0) {
    return NextResponse.json({ problems: read.problems }, { status: 422 });
  }

  /*
   * The columns must still line up with the file. If somebody re-picked a
   * different spreadsheet between the two steps, importing against the first
   * one's decisions would put every value in the wrong question.
   */
  const headers = read.table.headers;
  const planned = parsed.data.columns.map((c) => c.header);
  if (headers.length !== planned.length || headers.some((h, i) => h !== planned[i])) {
    return NextResponse.json(
      { error: 'That file does not match the one you reviewed. Please start again.' },
      { status: 409 },
    );
  }

  // A subject type from another organisation would be a tenant boundary
  // crossed, so it is resolved through the request connection under RLS.
  if (parsed.data.formType === 'registration') {
    if (!parsed.data.subjectTypeId) {
      return NextResponse.json({ error: 'Choose who these records are about.' }, { status: 400 });
    }
    const found = await withSession(session, async (tx) => {
      const { subjectTypes } = await import('@sangraha/db');
      const { and, eq } = await import('drizzle-orm');
      const [row] = await tx
        .select({ id: subjectTypes.id })
        .from(subjectTypes)
        .where(
          and(
            eq(subjectTypes.id, parsed.data.subjectTypeId!),
            eq(subjectTypes.orgId, session.orgId),
          ),
        )
        .limit(1);
      return row;
    });
    if (!found) return NextResponse.json({ error: 'Choose who these records are about.' }, { status: 400 });
  }

  const outcome = await importTable(getOwnerDb(), {
    orgId: session.orgId,
    userId: session.userId,
    formName: parsed.data.formName,
    formType: parsed.data.formType,
    subjectTypeId: parsed.data.subjectTypeId ?? null,
    displayNameColumns: parsed.data.displayNameColumns,
    columns: parsed.data.columns.map((column) => ({
      ...column,
      choices: column.choices ?? undefined,
      dataType: column.dataType as never,
      format: (TEXT_FORMATS as readonly string[]).includes(column.format ?? '')
        ? (column.format as never)
        : undefined,
    })),
    table: read.table,
    source: read.label,
  });

  // DDL, so it runs on the owner connection once the import has committed.
  await regenerateFormViews(getOwnerDb(), outcome.formId);

  return NextResponse.json(outcome);
}
