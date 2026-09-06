/**
 * Turning a spreadsheet into a form and its history, against the database.
 *
 * What is being tested is a migration: an organisation's ten years of records
 * arriving in one go. The failure that matters is not an exception — it is a
 * quiet one, where the form looks right and some of the rows are missing or
 * some of the values have been mangled on the way in.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { inferTable, parseCsv } from '@sangraha/form-engine';
import { importTable, type ImportColumn, type ImportPlan } from '../import/import-table';
import { regenerateFormViews } from '../analytics/generate';
import { formFields, forms, optionSets, options, subjects, submissions } from '../schema/index';
import { subjectTypes } from '../schema/config';
import {
  closeHarness,
  createTestOrg,
  dropTestOrg,
  hasDatabase,
  ownerDb,
  type TestOrg,
} from './harness';

const CSV = [
  'Name,Age,Date of birth,Email,Class,Active',
  'Sunita Devi,12,2013-06-01,sunita@ngo.org,Class 5,Yes',
  'Ramesh Kumar,13,2012-04-14,ramesh@ngo.org,Class 6,Yes',
  'Kavita Sharma,12,2013-09-20,kavita@ngo.org,Class 5,No',
  'Anjali Patil,14,2011-11-02,anjali@ngo.org,Class 6,Yes',
].join('\n');

describe.skipIf(!hasDatabase)('importing a spreadsheet', () => {
  let org: TestOrg;

  beforeAll(async () => {
    org = await createTestOrg('import');
  });

  afterAll(async () => {
    await dropTestOrg(org);
    await closeHarness();
  });

  /** Builds the plan the review screen would produce, with no overrides. */
  function planFor(
    csv: string,
    overrides: Partial<ImportPlan> = {},
    tweak: (column: ImportColumn) => ImportColumn = (c) => c,
  ): ImportPlan {
    const table = parseCsv(csv);
    const columns: ImportColumn[] = inferTable(table).map((guess) =>
      tweak({
        header: guess.header,
        dataType: guess.dataType,
        format: guess.format,
        choices: guess.choices,
        // What the review screen offers by default: required where nothing is
        // blank, unique where nothing repeats.
        isRequired: guess.blanks === 0,
        isUnique: false,
        include: true,
      }),
    );

    return {
      orgId: org.id,
      userId: org.adminId,
      formName: 'Beneficiaries',
      formType: 'standalone',
      columns,
      table,
      source: 'beneficiaries.csv',
      ...overrides,
    };
  }

  it('creates a form whose questions are the spreadsheet columns', async () => {
    const result = await importTable(ownerDb(), planFor(CSV, { formName: 'Intake One' }));

    const fields = await ownerDb()
      .select({
        key: formFields.key,
        label: formFields.label,
        dataType: formFields.dataType,
        sortOrder: formFields.sortOrder,
      })
      .from(formFields)
      .where(eq(formFields.formVersionId, result.versionId));

    const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));

    // The headings the organisation already knows, in the order they wrote
    // them — that is what makes the form recognisable to their team.
    expect(fields.map((f) => f.key).sort()).toEqual(
      ['active', 'age', 'class', 'date_of_birth', 'email', 'name'].sort(),
    );
    expect(byKey['name']!.label).toEqual({ en: 'Name' });
    expect(byKey['age']!.dataType).toBe('integer');
    expect(byKey['date_of_birth']!.dataType).toBe('date');
    expect(byKey['active']!.dataType).toBe('boolean');
    expect(byKey['class']!.dataType).toBe('single_choice');
  });

  it('publishes it, so a worker can use it immediately', async () => {
    const result = await importTable(ownerDb(), planFor(CSV, { formName: 'Intake Two' }));

    const [form] = await ownerDb()
      .select({ currentVersionId: forms.currentVersionId })
      .from(forms)
      .where(eq(forms.id, result.formId));

    expect(form?.currentVersionId).toBe(result.versionId);
  });

  it('imports every row', async () => {
    const result = await importTable(ownerDb(), planFor(CSV, { formName: 'Intake Three' }));

    expect(result.imported).toBe(4);
    expect(result.skippedCells).toEqual([]);

    const rows = await ownerDb()
      .select({ data: submissions.data })
      .from(submissions)
      .where(eq(submissions.formId, result.formId));

    expect(rows).toHaveLength(4);
    const sunita = rows.find((r) => (r.data as Record<string, unknown>).name === 'Sunita Devi');
    expect(sunita?.data).toMatchObject({
      name: 'Sunita Devi',
      age: 12,
      date_of_birth: '2013-06-01',
      email: 'sunita@ngo.org',
      active: true,
    });
  });

  it('builds the answer list, and stores codes rather than the cell text', async () => {
    const result = await importTable(ownerDb(), planFor(CSV, { formName: 'Intake Four' }));

    const [field] = await ownerDb()
      .select({ optionSetId: formFields.optionSetId })
      .from(formFields)
      .where(and(eq(formFields.formVersionId, result.versionId), eq(formFields.key, 'class')));

    expect(field?.optionSetId).toBeTruthy();

    const choices = await ownerDb()
      .select({ code: options.code, label: options.label })
      .from(options)
      .where(eq(options.optionSetId, field!.optionSetId!));

    expect(choices.map((c) => c.code).sort()).toEqual(['class_5', 'class_6']);

    // Stored as the stable code, which is what lets the label be renamed or
    // translated later without touching a single answer.
    const rows = await ownerDb()
      .select({ data: submissions.data })
      .from(submissions)
      .where(eq(submissions.formId, result.formId));

    expect(rows.map((r) => (r.data as Record<string, unknown>).class).sort()).toEqual([
      'class_5',
      'class_5',
      'class_6',
      'class_6',
    ]);
  });

  it('marks the records as already checked, and says where they came from', async () => {
    const result = await importTable(ownerDb(), planFor(CSV, { formName: 'Intake Five' }));

    const rows = await ownerDb()
      .select({
        status: submissions.status,
        reviewedBy: submissions.reviewedBy,
        deviceMeta: submissions.deviceMeta,
      })
      .from(submissions)
      .where(eq(submissions.formId, result.formId));

    for (const row of rows) {
      // History being migrated, not field capture awaiting a check.
      expect(row.status).toBe('approved');
      expect(row.reviewedBy).toBe(org.adminId);
      // Provenance, so an auditor can tell an imported record from a collected
      // one without asking anybody.
      expect(row.deviceMeta).toMatchObject({
        import: { source: 'beneficiaries.csv' },
      });
    }
  });

  describe('cells that will not convert', () => {
    const messy = [
      'Name,Age',
      'Sunita,12',
      'Ramesh,about 40',
      'Kavita,13',
      'Anjali,?',
    ].join('\n');

    it('imports the rows and reports the cells', async () => {
      // Forced to a number, as an admin would after overriding the guess for a
      // column that is *mostly* ages.
      const plan = planFor(messy, { formName: 'Messy One' }, (column) =>
        column.header === 'Age' ? { ...column, dataType: 'integer', isRequired: false } : column,
      );

      const result = await importTable(ownerDb(), plan);

      // Every row survives; refusing all four over two cells would stop the
      // migration dead.
      expect(result.imported).toBe(4);
      expect(result.skippedCells).toEqual([
        { row: 2, header: 'Age', value: 'about 40' },
        { row: 4, header: 'Age', value: '?' },
      ]);
    });

    it('leaves the cell blank rather than storing something wrong', async () => {
      const plan = planFor(messy, { formName: 'Messy Two' }, (column) =>
        column.header === 'Age' ? { ...column, dataType: 'integer', isRequired: false } : column,
      );
      const result = await importTable(ownerDb(), plan);

      const rows = await ownerDb()
        .select({ data: submissions.data })
        .from(submissions)
        .where(eq(submissions.formId, result.formId));

      const ramesh = rows.find((r) => (r.data as Record<string, unknown>).name === 'Ramesh');
      expect(ramesh?.data).toEqual({ name: 'Ramesh' });
    });
  });

  it('builds the answer list when the admin overrode the guess', async () => {
    /*
     * The defect: the review screen's "Becomes" dropdown sets `dataType` and
     * never `choices`. A column inferred as text and overridden to "Choose one
     * answer" arrived with `choices: undefined`, so no option set was created,
     * the field was inserted with `option_set_id: null`, and every cell then
     * failed to match a code and was discarded — the whole column lost, while
     * the skipped-cell list (capped at 200) made it look like a small problem.
     */
    const villages = [
      'Name,Village',
      'Sunita,Kittur',
      'Ramesh,Sampgaon',
      'Kavita,Kittur',
      'Anjali,Bailhongal',
    ].join('\n');

    // Exactly what the dropdown sends: a new type and no choices with it.
    const plan = planFor(villages, { formName: 'Overridden' }, (column) =>
      column.header === 'Village'
        ? { ...column, dataType: 'single_choice' as const, choices: undefined }
        : column,
    );

    const result = await importTable(ownerDb(), plan);

    const [field] = await ownerDb()
      .select({ id: formFields.id, key: formFields.key, optionSetId: formFields.optionSetId })
      .from(formFields)
      .where(and(eq(formFields.formVersionId, result.versionId), eq(formFields.key, 'village')));

    expect(field?.optionSetId).not.toBeNull();

    const codes = await ownerDb()
      .select({ code: options.code })
      .from(options)
      .where(eq(options.optionSetId, field!.optionSetId!));
    expect(codes.map((c) => c.code).sort()).toEqual(['bailhongal', 'kittur', 'sampgaon']);

    // And, the point of it: every value came through, as a stable code.
    const rows = await ownerDb()
      .select({ data: submissions.data })
      .from(submissions)
      .where(eq(submissions.formId, result.formId));
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => (r.data as Record<string, unknown>).village).sort()).toEqual([
      'bailhongal',
      'kittur',
      'kittur',
      'sampgaon',
    ]);
    expect(result.skippedCells).toEqual([]);
  });

  it('reads a repeated value as one choice however it was typed', async () => {
    // The distinct list is folded on case, so "Kittur" and "kittur" are one
    // village rather than two — the same normalisation the inferred path uses.
    const mixed = ['Name,Village', 'A,Kittur', 'B,kittur', 'C,KITTUR'].join('\n');
    const plan = planFor(mixed, { formName: 'Mixed Case' }, (column) =>
      column.header === 'Village'
        ? { ...column, dataType: 'single_choice' as const, choices: undefined }
        : column,
    );

    const result = await importTable(ownerDb(), plan);

    const [field] = await ownerDb()
      .select({ optionSetId: formFields.optionSetId })
      .from(formFields)
      .where(and(eq(formFields.formVersionId, result.versionId), eq(formFields.key, 'village')));
    const codes = await ownerDb()
      .select({ code: options.code })
      .from(options)
      .where(eq(options.optionSetId, field!.optionSetId!));

    expect(codes).toHaveLength(1);
    expect(result.imported).toBe(3);
  });

  it('leaves out a column the admin excluded', async () => {
    const plan = planFor(CSV, { formName: 'Excluded' }, (column) =>
      column.header === 'Email' ? { ...column, include: false } : column,
    );
    const result = await importTable(ownerDb(), plan);

    const keys = await ownerDb()
      .select({ key: formFields.key })
      .from(formFields)
      .where(eq(formFields.formVersionId, result.versionId));

    expect(keys.map((k) => k.key)).not.toContain('email');

    const [row] = await ownerDb()
      .select({ data: submissions.data })
      .from(submissions)
      .where(eq(submissions.formId, result.formId))
      .limit(1);
    expect(Object.keys(row!.data as object)).not.toContain('email');
  });

  it('registers people when the form is a registration', async () => {
    const [type] = await ownerDb()
      .insert(subjectTypes)
      .values({
        orgId: org.id,
        code: 'imported_student',
        name: { en: 'Student' },
        displayNameFields: ['name'],
      })
      .returning({ id: subjectTypes.id });

    const result = await importTable(
      ownerDb(),
      planFor(CSV, {
        formName: 'Registered',
        formType: 'registration',
        subjectTypeId: type!.id,
        displayNameColumns: ['Name'],
      }),
    );

    expect(result.subjectsCreated).toBe(4);

    const people = await ownerDb()
      .select({ displayName: subjects.displayName })
      .from(subjects)
      .where(eq(subjects.subjectTypeId, type!.id));

    // Findable by name the moment the import finishes, which is the point of
    // migrating into the registry rather than into a pile of submissions.
    expect(people.map((p) => p.displayName).sort()).toEqual([
      'Anjali Patil',
      'Kavita Sharma',
      'Ramesh Kumar',
      'Sunita Devi',
    ]);
  });

  it('does not collide with an existing form of the same name', async () => {
    const first = await importTable(ownerDb(), planFor(CSV, { formName: 'Same Name' }));
    const second = await importTable(ownerDb(), planFor(CSV, { formName: 'Same Name' }));

    expect(first.formSlug).toBe('same_name');
    expect(second.formSlug).not.toBe(first.formSlug);
  });

  it('produces an analytics view like any other form', async () => {
    const result = await importTable(ownerDb(), planFor(CSV, { formName: 'Analytics Check' }));
    await regenerateFormViews(ownerDb(), result.formId);

    const columns = (await ownerDb().execute(`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = '${org.analyticsSchema}' AND table_name = '${result.formSlug}'
    `)) as unknown as { column_name: string; data_type: string }[];

    const byName = Object.fromEntries(columns.map((c) => [c.column_name, c.data_type]));

    // Typed columns, not a pile of text — the import is a first-class form.
    expect(byName['age']).toBe('bigint');
    expect(byName['date_of_birth']).toBe('date');
    expect(byName['active']).toBe('boolean');
    // A choice question carries its readable label alongside the code.
    expect(byName['class_label']).toBeDefined();
  });

  it('creates nothing at all if the import fails part way', async () => {
    const before = await ownerDb()
      .select({ id: forms.id })
      .from(forms)
      .where(eq(forms.orgId, org.id));

    // A subject type belonging to nobody: the subject insert violates its
    // foreign key, part way through the rows.
    const plan = planFor(CSV, {
      formName: 'Rolled Back',
      formType: 'registration',
      subjectTypeId: '00000000-0000-0000-0000-000000000000',
      displayNameColumns: ['Name'],
    });

    await expect(importTable(ownerDb(), plan)).rejects.toThrow();

    const after = await ownerDb()
      .select({ id: forms.id })
      .from(forms)
      .where(eq(forms.orgId, org.id));

    // A half-done migration leaves a published form with some of the records
    // under it and no way to tell which.
    expect(after).toHaveLength(before.length);

    const orphanSets = await ownerDb()
      .select({ id: optionSets.id })
      .from(optionSets)
      .where(eq(optionSets.code, 'class_rolled_back'));
    expect(orphanSets).toHaveLength(0);
  });
});
