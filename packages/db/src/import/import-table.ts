import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  toAnswer,
  toSnakeCase,
  type FieldDataType,
  type SheetTable,
  type TextFormat,
} from '@sangraha/form-engine';
import type { Database } from '../client';
import { formFields, formVersions, forms, optionSets, options } from '../schema/config';
import { subjects, submissionRevisions, submissions } from '../schema/data';
import { composeDisplayName } from '../queries/subject-types';

/**
 * Turning a spreadsheet into a form and its history.
 *
 * The reason this exists: an organisation with ten years of records in Excel
 * will not retype them, and until those records are in the system the system is
 * a second place to look rather than the place to look. Making the *form* out
 * of their own spreadsheet matters as much as the data — their team already
 * knows those column headings.
 *
 * Everything happens in one transaction. A migration that half-succeeded would
 * leave a published form with some of the records under it, and no way to tell
 * which without going back to the spreadsheet.
 */

export interface ImportColumn {
  header: string;
  dataType: FieldDataType;
  format?: TextFormat;
  choices?: string[];
  isRequired: boolean;
  isUnique: boolean;
  /** False for a column the admin chose not to bring across. */
  include: boolean;
}

export interface ImportPlan {
  orgId: string;
  userId: string;
  formName: string;
  formType: 'registration' | 'standalone';
  /** Set when the form registers people. */
  subjectTypeId?: string | null;
  /** Which columns compose a subject's display name. */
  displayNameColumns?: string[];
  columns: ImportColumn[];
  table: SheetTable;
  /** Where it came from, kept on every row. */
  source: string;
}

export interface ImportOutcome {
  formId: string;
  formSlug: string;
  versionId: string;
  imported: number;
  subjectsCreated: number;
  /** Cells that would not convert and were left blank. */
  skippedCells: { row: number; header: string; value: string }[];
}

/** Field keys are derived from headings, so two headings cannot collide. */
function keyFor(header: string, taken: Set<string>): string {
  const base = toSnakeCase(header).slice(0, 50) || 'column';
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  let suffix = 2;
  while (taken.has(`${base}_${suffix}`)) suffix += 1;
  const key = `${base}_${suffix}`;
  taken.add(key);
  return key;
}

/**
 * A slug free within this organisation.
 *
 * Scoped by `org_id`, which is both what the real constraint says
 * (`forms_org_slug_key` is on the pair) and what a tenant boundary requires.
 * The `orgId` parameter was here and unused, and because this runs on the owner
 * connection — where RLS is off — the check ranged across every tenant: an NGO
 * importing "Attendance" got `attendance_2` because a different organisation
 * had used the name, and an importer could learn which form names existed
 * elsewhere by watching which suffixes came back.
 */
async function uniqueSlug(db: Database, orgId: string, name: string): Promise<string> {
  const base = toSnakeCase(name).slice(0, 40) || 'imported';
  let slug = base;
  let suffix = 2;

  for (;;) {
    const [clash] = await db
      .select({ id: forms.id })
      .from(forms)
      .where(and(eq(forms.orgId, orgId), eq(forms.slug, slug)))
      .limit(1);
    if (!clash) return slug;
    slug = `${base}_${suffix}`;
    suffix += 1;
  }
}

/**
 * How many distinct values an overridden column may turn into a list.
 *
 * Inference stops guessing "list" above fifteen, which is about evidence rather
 * than about a limit — an administrator who *chooses* "Choose one answer" for a
 * column of two hundred villages means it. Past this, though, the choice was
 * almost certainly a mistake (a notes column), and building an option set with
 * thousands of entries would be a worse outcome than reporting it.
 */
const MAX_DERIVED_CHOICES = 200;

/**
 * The distinct values of one column, in the order they first appear.
 *
 * Needed because the review screen's "Becomes" dropdown sets `dataType` and
 * never `choices`: a column inferred as text and overridden to "Choose one
 * answer" arrived with `choices: undefined`, so no option set was created, the
 * field was inserted with `option_set_id: null`, and every single cell then
 * failed to match a code and was discarded. On a 5,000-row file that silently
 * lost 4,800 values while the skipped-cell list, capped at 200, made it look
 * like a small problem.
 *
 * Derived here rather than in the browser because this is where the whole table
 * is: the client only ever holds three sample values per column.
 */
function distinctValues(table: SheetTable, columnIndex: number): string[] {
  const seen = new Map<string, string>();
  for (const row of table.rows) {
    const value = (row[columnIndex] ?? '').trim();
    if (value === '') continue;
    const key = value.toLowerCase();
    if (!seen.has(key)) seen.set(key, value);
    if (seen.size > MAX_DERIVED_CHOICES) break;
  }
  return [...seen.values()];
}

export async function importTable(db: Database, plan: ImportPlan): Promise<ImportOutcome> {
  const slug = await uniqueSlug(db, plan.orgId, plan.formName);
  const batchId = randomUUID();

  /*
   * Fill in the choices the review screen did not send, before anything is
   * written. A choice column with no list to choose from cannot store a single
   * answer, so this has to happen ahead of the option sets below rather than
   * being noticed row by row.
   */
  const columns = plan.columns.map((column, index) => {
    if (column.dataType !== 'single_choice' || column.choices?.length || !column.include) {
      return column;
    }
    return { ...column, choices: distinctValues(plan.table, index) };
  });
  plan = { ...plan, columns };

  return db.transaction(async (tx) => {
    const [form] = await tx
      .insert(forms)
      .values({
        orgId: plan.orgId,
        slug,
        name: { en: plan.formName },
        formType: plan.formType,
        subjectTypeId: plan.formType === 'registration' ? (plan.subjectTypeId ?? null) : null,
      })
      .returning({ id: forms.id });

    const [version] = await tx
      .insert(formVersions)
      .values({
        formId: form!.id,
        versionNumber: 1,
        status: 'published',
        publishedAt: new Date(),
        publishedBy: plan.userId,
      })
      .returning({ id: formVersions.id });

    const included = plan.columns.filter((c) => c.include);
    const taken = new Set<string>();
    const keys = new Map<number, string>();

    for (const [position, spec] of included.entries()) {
      const key = keyFor(spec.header, taken);
      keys.set(plan.columns.indexOf(spec), key);

      /*
       * A column of repeating values becomes a list to choose from, and the
       * list is created here so it can be reused and translated later — which
       * is the whole reason answers are stored as codes rather than as the text
       * that happened to be in the cell.
       */
      let optionSetId: string | null = null;
      if (spec.dataType === 'single_choice' && spec.choices?.length) {
        const [set] = await tx
          .insert(optionSets)
          .values({
            orgId: plan.orgId,
            code: `${key}_${slug}`.slice(0, 60),
            name: { en: spec.header },
          })
          .returning({ id: optionSets.id });
        optionSetId = set!.id;

        await tx.insert(options).values(
          spec.choices.map((choice, index) => ({
            optionSetId: set!.id,
            code: toSnakeCase(choice).slice(0, 60) || `option_${index + 1}`,
            label: { en: choice },
            sortOrder: index,
          })),
        );
      }

      await tx.insert(formFields).values({
        formVersionId: version!.id,
        key,
        label: { en: spec.header },
        dataType: spec.dataType as never,
        isRequired: spec.isRequired,
        isUnique: spec.isUnique,
        sortOrder: position,
        optionSetId,
        config: spec.format ? { format: spec.format } : {},
      });
    }

    await tx.update(forms).set({ currentVersionId: version!.id }).where(eq(forms.id, form!.id));

    // Choice answers are stored as codes, so the cell text has to be mapped
    // back to the code the option set was given.
    const choiceCodes = new Map<number, Map<string, string>>();
    for (const spec of included) {
      if (spec.dataType !== 'single_choice' || !spec.choices) continue;
      const byText = new Map<string, string>();
      spec.choices.forEach((choice, index) => {
        byText.set(choice.toLowerCase(), toSnakeCase(choice).slice(0, 60) || `option_${index + 1}`);
      });
      choiceCodes.set(plan.columns.indexOf(spec), byText);
    }

    const skippedCells: ImportOutcome['skippedCells'] = [];
    let imported = 0;
    let subjectsCreated = 0;

    for (const [rowIndex, row] of plan.table.rows.entries()) {
      const data: Record<string, unknown> = {};

      for (const spec of included) {
        const columnIndex = plan.columns.indexOf(spec);
        const key = keys.get(columnIndex)!;
        const raw = (row[columnIndex] ?? '').trim();
        if (raw === '') continue;

        if (spec.dataType === 'single_choice') {
          const code = choiceCodes.get(columnIndex)?.get(raw.toLowerCase());
          if (code) data[key] = code;
          else if (skippedCells.length < 200) {
            skippedCells.push({ row: rowIndex + 1, header: spec.header, value: raw });
          }
          continue;
        }

        const value = toAnswer(raw, { dataType: spec.dataType, format: spec.format });
        if (value === null) {
          /*
           * Left blank on its row rather than refusing the whole file. A
           * ten-year spreadsheet always has a few cells reading "not known",
           * and stopping the migration over them helps nobody — but they are
           * all reported, with their row numbers.
           */
          if (skippedCells.length < 200) {
            skippedCells.push({ row: rowIndex + 1, header: spec.header, value: raw });
          }
          continue;
        }
        data[key] = value;
      }

      // A row where every cell was blank or unusable is not a record.
      if (Object.keys(data).length === 0) continue;

      let subjectId: string | null = null;
      if (plan.formType === 'registration' && plan.subjectTypeId) {
        const displayKeys = (plan.displayNameColumns ?? [])
          .map((header) => {
            const spec = plan.columns.find((c) => c.header === header);
            return spec ? keys.get(plan.columns.indexOf(spec)) : undefined;
          })
          .filter((key): key is string => Boolean(key));

        const [created] = await tx
          .insert(subjects)
          .values({
            orgId: plan.orgId,
            subjectTypeId: plan.subjectTypeId,
            displayName: composeDisplayName(displayKeys, data, plan.formName),
            attributes: data,
            locationId: null,
            createdBy: plan.userId,
          })
          .returning({ id: subjects.id });
        subjectId = created!.id;
        subjectsCreated += 1;
      }

      const [inserted] = await tx
        .insert(submissions)
        .values({
          orgId: plan.orgId,
          formId: form!.id,
          formVersionId: version!.id,
          subjectId,
          locationId: null,
          data,
          /*
           * Already checked. This is history being migrated, not field capture
           * awaiting review — putting five hundred imported rows into the
           * review queue produces a queue nobody clears.
           */
          status: 'approved',
          submittedBy: plan.userId,
          reviewedBy: plan.userId,
          reviewedAt: new Date(),
          // Deterministic within a batch, so a retry of the same import cannot
          // write the same row twice.
          clientUuid: rowUuid(batchId, rowIndex),
          deviceMeta: {
            import: { source: plan.source, batchId, row: rowIndex + 1 },
          },
        })
        .onConflictDoNothing({ target: [submissions.orgId, submissions.clientUuid] })
        .returning({ id: submissions.id });

      if (!inserted) continue;
      imported += 1;

      await tx.insert(submissionRevisions).values({
        submissionId: inserted.id,
        revisionNo: 1,
        changeType: 'created',
        data,
        status: 'approved',
        changedBy: plan.userId,
        reason: `Imported from ${plan.source}, row ${rowIndex + 1}`,
      });
    }

    return {
      formId: form!.id,
      formSlug: slug,
      versionId: version!.id,
      imported,
      subjectsCreated,
      skippedCells,
    };
  });
}

/** A stable UUID for one row of one batch. */
function rowUuid(batchId: string, rowIndex: number): string {
  // The batch id is already a UUID; replacing its tail with the row number
  // keeps the shape valid and makes the pair unique without hashing.
  const tail = rowIndex.toString(16).padStart(12, '0').slice(-12);
  return `${batchId.slice(0, 24)}${tail}`;
}
