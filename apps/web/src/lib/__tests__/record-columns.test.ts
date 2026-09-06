/**
 * Deciding what a Records table shows.
 *
 * The property that matters is not that the pretty columns are pretty — it is
 * that **nothing is lost**. Every column the view has ends up in exactly one of
 * the three groups, so a question can never quietly stop being visible because
 * a rule did not anticipate it.
 */
import { describe, expect, it } from 'vitest';
import { describeMainViewColumns, generateFormViews } from '@sangraha/form-engine';
import type {
  FieldDataType,
  FieldDefinition,
  FormVersionDefinition,
  OptionSetDefinition,
} from '@sangraha/form-engine';
import type { RecordColumn } from '@sangraha/db';
import { idsToResolve, planColumns, visibleColumns } from '../record-columns';

/*
 * Local fixtures rather than the form-engine's own: those live in its
 * `__tests__` folder, which is not an exported entry point, and reaching across
 * package boundaries into test files is how a private helper becomes an
 * accidental API.
 */
function field(
  key: string,
  dataType: FieldDataType,
  overrides: Partial<FieldDefinition> = {},
): FieldDefinition {
  return {
    id: `id-${key}`,
    key,
    label: { en: key },
    dataType,
    isRequired: false,
    isUnique: false,
    sortOrder: 0,
    parentGroupId: null,
    optionSet: null,
    config: {},
    visibilityRule: null,
    isArchived: false,
    ...overrides,
  };
}

function optionSet(code: string, codes: string[]): OptionSetDefinition {
  return {
    id: `os-${code}`,
    code,
    name: { en: code },
    options: codes.map((c, i) => ({
      id: `o-${c}`,
      code: c,
      label: { en: c.toUpperCase() },
      sortOrder: i,
      isActive: true,
    })),
  };
}

function version(versionNumber: number, fields: FieldDefinition[]): FormVersionDefinition {
  return {
    id: `fv-${versionNumber}`,
    formId: 'form-1',
    formSlug: 'intake',
    versionNumber,
    name: { en: 'Intake' },
    formType: 'standalone',
    subjectTypeId: null,
    fields: fields.map((f, i) => ({ ...f, sortOrder: f.sortOrder || i })),
  };
}

/** The columns a view genuinely has, as `information_schema` would report them. */
function viewColumns(versions: Parameters<typeof describeMainViewColumns>[0]): RecordColumn[] {
  return generateFormViews({
    formId: 'form-1',
    formSlug: 'intake',
    schema: 'analytics_test',
    versions,
  })[0]!.columns.map((c) => ({ name: c.name, pgType: c.pgType }));
}

function planFor(versions: Parameters<typeof describeMainViewColumns>[0]) {
  return planColumns(viewColumns(versions), describeMainViewColumns(versions), 'en');
}

const SIMPLE = [
  version(1, [
    field('full_name', 'short_text', { label: { en: 'Full name' } }),
    field('dob', 'date', { label: { en: 'Date of birth' } }),
  ]),
];

describe('sorting a view into what to show', () => {
  it('loses nothing — every column lands in exactly one group', () => {
    const columns = viewColumns(SIMPLE);
    const plan = planFor(SIMPLE);

    const placed = [...plan.essentials, ...plan.answers, ...plan.technical].map((c) => c.name);

    expect(placed.slice().sort()).toEqual(columns.map((c) => c.name).sort());
    expect(new Set(placed).size).toBe(placed.length);
  });

  it('puts the answers up front, by their real names', () => {
    const plan = planFor(SIMPLE);

    expect(plan.answers.map((c) => c.label)).toEqual(['Full name', 'Date of birth']);
    // Four readable essentials, not thirteen columns of machinery.
    expect(plan.essentials.map((c) => c.label)).toEqual(['When', 'About', 'Sent by', 'Status']);
  });

  it('hides the machinery', () => {
    const technical = planFor(SIMPLE).technical.map((c) => c.name);

    for (const name of ['submission_id', 'org_id', 'form_version', 'created_at', 'updated_at']) {
      expect(technical).toContain(name);
    }
    // Kept raw: somebody who turned these on wants the column name they know.
    expect(planFor(SIMPLE).technical.every((c) => c.label === c.name)).toBe(true);
  });

  it('shows a choice question by its label and hides the code', () => {
    const versions = [
      version(1, [
        field('grade', 'single_choice', {
          label: { en: 'Which class?' },
          optionSet: optionSet('grade', ['g1', 'g2']),
        }),
      ]),
    ];
    const plan = planFor(versions);

    expect(plan.answers.map((c) => c.name)).toEqual(['grade_label']);
    expect(plan.answers[0]!.label).toBe('Which class?');
    // The stable code is still there for anyone who needs to join on it.
    expect(plan.technical.map((c) => c.name)).toContain('grade');
  });

  it('shows a multi-choice as its list and hides the one-hots', () => {
    // The case a `_label` rule alone gets wrong: multi-choice has no `_label`,
    // it has an array plus a boolean per option.
    const versions = [
      version(1, [
        field('services', 'multi_choice', {
          label: { en: 'Services used' },
          optionSet: optionSet('svc', ['anc', 'imm']),
        }),
      ]),
    ];
    const plan = planFor(versions);

    expect(plan.answers.map((c) => c.name)).toEqual(['services']);
    expect(plan.answers[0]!.kind).toBe('choices');
    expect(plan.technical.map((c) => c.name)).toEqual(
      expect.arrayContaining(['services_anc', 'services_imm']),
    );
  });

  it('keeps an unmatched column rather than dropping it', () => {
    /*
     * The view and the form definition can disagree — a retired option leaves
     * its one-hot in the view until the next `db:views`. The view is the
     * authority, so the stray column stays, raw-named and technical.
     */
    const columns = [...viewColumns(SIMPLE), { name: 'services_retired', pgType: 'boolean' }];
    const plan = planColumns(columns, describeMainViewColumns(SIMPLE), 'en');

    const stray = plan.technical.find((c) => c.name === 'services_retired');
    expect(stray).toBeDefined();
    expect(stray?.label).toBe('services_retired');
  });

  it('treats an attachment as machinery', () => {
    // A column of file ids is not something to read across a table.
    const versions = [version(1, [field('photo', 'photo', { label: { en: 'Photo' } })])];
    const plan = planFor(versions);

    expect(plan.answers).toHaveLength(0);
    // The column is the attachment's id, and it is still there — hidden, not
    // dropped, because an admin chasing a missing upload will want it.
    expect(plan.technical.map((c) => c.name)).toContain('photo_attachment_id');
  });

  it('marks a link-to-a-person column as a person', () => {
    const versions = [
      version(1, [field('donor', 'subject_ref', { label: { en: 'Donor' } })]),
    ];
    const plan = planFor(versions);

    expect(plan.answers[0]).toMatchObject({ name: 'donor', label: 'Donor', kind: 'person' });
    // So the resolver knows to look this one up as well as `subject_id`.
    expect(plan.personColumns).toEqual(expect.arrayContaining(['subject_id', 'donor']));
  });

  it('shows the id column of a person link, not its name column', () => {
    /*
     * `subject_ref` emits `donor` and `donor_name`. The opposite way round from
     * a choice pair, deliberately: the screen resolves the id to a name *and*
     * links to that person, so showing `donor_name` instead would trade a link
     * for plain text. The name column exists for the CSV, which cannot resolve
     * anything, and is technical here.
     */
    const versions = [
      version(1, [field('donor', 'subject_ref', { label: { en: 'Donor' } })]),
    ];
    const plan = planFor(versions);

    expect(plan.answers.map((c) => c.name)).toEqual(['donor']);
    expect(plan.technical.map((c) => c.name)).toContain('donor_name');
    // And it is still one column per group — the name did not double the table.
    expect(plan.answers).toHaveLength(1);

    /*
     * The one that matters. `donor_name` shares its `dataType` with `donor`,
     * and treating it as a person sent "Sunita Devi" to a uuid lookup —
     * `invalid input syntax for type uuid`, a 500 on the whole screen.
     */
    expect(plan.personColumns).toContain('donor');
    expect(plan.personColumns).not.toContain('donor_name');
    expect(plan.technical.find((c) => c.name === 'donor_name')?.kind).not.toBe('person');
  });

  it('never asks the resolver for a column that does not hold ids', () => {
    // Stated over the whole plan rather than one column: any future companion
    // column inherits its field's `dataType` too.
    const versions = [
      version(1, [
        field('donor', 'subject_ref', { label: { en: 'Donor' } }),
        field('grade', 'single_choice', { optionSet: optionSet('grade', ['g1']) }),
      ]),
    ];
    const plan = planFor(versions);

    const byName = new Map(
      [...plan.essentials, ...plan.answers, ...plan.technical].map((c) => [c.name, c]),
    );
    for (const name of plan.personColumns) {
      expect(byName.get(name)?.kind, `${name} is resolved as a person`).toBe('person');
    }
  });
});

describe('what actually gets rendered', () => {
  const plan = planFor(SIMPLE);

  it('leaves the machinery out unless it is asked for', () => {
    const rows = [{ subject_id: 'a', full_name: 'x' }];

    expect(visibleColumns(plan, rows, false).map((c) => c.name)).not.toContain('submission_id');
    expect(visibleColumns(plan, rows, true).map((c) => c.name)).toContain('submission_id');
  });

  it('drops "About" on a form that is about nobody', () => {
    // A standalone survey has no subject, so the column would be empty on every
    // row — worse than absent, because it looks like missing data.
    const standalone = [{ subject_id: null, full_name: 'x' }];
    expect(visibleColumns(plan, standalone, false).map((c) => c.label)).not.toContain('About');

    const withPeople = [{ subject_id: null }, { subject_id: 'abc' }];
    expect(visibleColumns(plan, withPeople, false).map((c) => c.label)).toContain('About');
  });
});

describe('collecting the ids a page needs', () => {
  it('gathers each kind once, de-duplicated', () => {
    const versions = [version(1, [field('donor', 'subject_ref')])];
    const plan = planFor(versions);

    const ids = idsToResolve(plan, [
      { subject_id: 's1', submitted_by: 'u1', location_id: 'l1', donor: 's2' },
      { subject_id: 's1', submitted_by: 'u1', location_id: 'l1', donor: 's3' },
      { subject_id: null, submitted_by: 'u2', location_id: null, donor: null },
    ]);

    expect(ids.subjectIds.sort()).toEqual(['s1', 's2', 's3']);
    expect(ids.userIds.sort()).toEqual(['u1', 'u2']);
    expect(ids.locationIds).toEqual(['l1']);
  });

  it('asks for nothing when there is nothing to ask about', () => {
    const plan = planFor(SIMPLE);
    expect(idsToResolve(plan, [])).toEqual({ subjectIds: [], userIds: [], locationIds: [] });
  });
});
