import { describe, expect, it } from 'vitest';
import {
  analyticsSchemaName,
  describeMainViewColumns,
  generateFormViews,
  mainViewName,
  toSnakeCase,
} from '../analytics-view';
import { field, optionSet, version } from './fixtures';

const FORM_ID = '11111111-1111-1111-1111-111111111111';
const SCHEMA = 'analytics_demo_ngo';

const generate = (versions: Parameters<typeof generateFormViews>[0]['versions']) =>
  generateFormViews({
    formId: FORM_ID,
    formSlug: 'school_attendance',
    schema: SCHEMA,
    versions,
  });

const columnNames = (view: { columns: { name: string }[] }) => view.columns.map((c) => c.name);

describe('generateFormViews', () => {
  it('emits one view named after the form slug, in the organisation schema', () => {
    const views = generate([version(1, [field('student_name', 'short_text')])]);

    expect(views).toHaveLength(1);
    expect(views[0]?.name).toBe('school_attendance');
    expect(views[0]?.schema).toBe(SCHEMA);
    expect(views[0]?.sql).toContain(
      'CREATE OR REPLACE VIEW "analytics_demo_ngo"."school_attendance"',
    );
  });

  it('isolates identically-slugged forms from different organisations', () => {
    // Form slugs are only unique within an organisation. Two NGOs both building
    // a `school_attendance` form must not overwrite each other's view.
    const versions = [version(1, [field('student_name', 'short_text')])];
    const a = generateFormViews({
      formId: FORM_ID,
      formSlug: 'school_attendance',
      schema: analyticsSchemaName('shiksha-demo'),
      versions,
    });
    const b = generateFormViews({
      formId: '22222222-2222-2222-2222-222222222222',
      formSlug: 'school_attendance',
      schema: analyticsSchemaName('pratham-demo'),
      versions,
    });

    expect(a[0]?.schema).toBe('analytics_shiksha_demo');
    expect(b[0]?.schema).toBe('analytics_pratham_demo');
    expect(a[0]?.schema).not.toBe(b[0]?.schema);
  });

  it('names columns after the immutable field key, not the label', () => {
    // The whole point of the key/label split: an admin renaming a question in
    // any language must not move or rename an analytics column.
    const v1 = version(1, [field('child_name', 'short_text', { label: { en: "Child's name" } })]);
    const v2 = version(2, [field('child_name', 'short_text', { label: { en: 'Student name', hi: 'छात्र का नाम' } })]);

    const before = generate([v1]);
    const after = generate([v1, v2]);

    expect(columnNames(before[0]!)).toContain('child_name');
    expect(columnNames(after[0]!)).toEqual(columnNames(before[0]!));
  });

  it('keeps a column for a field that only existed in an older version', () => {
    // Historical answers stay readable after a question is removed.
    const v1 = version(1, [field('student_name', 'short_text'), field('old_metric', 'integer')]);
    const v2 = version(2, [field('student_name', 'short_text')]);

    expect(columnNames(generate([v1, v2])[0]!)).toContain('old_metric');
  });

  it('adds a column for a field introduced in a later version', () => {
    const v1 = version(1, [field('student_name', 'short_text')]);
    const v2 = version(2, [field('student_name', 'short_text'), field('present', 'boolean')]);

    const columns = columnNames(generate([v1, v2])[0]!);
    expect(columns).toContain('student_name');
    expect(columns).toContain('present');
  });

  it('always exposes the submission dimensions analysts join on', () => {
    const columns = columnNames(generate([version(1, [field('a', 'short_text')])])[0]!);

    expect(columns).toEqual(
      expect.arrayContaining([
        'submission_id',
        'org_id',
        'subject_id',
        'form_version',
        'status',
        'submitted_by',
        'submitted_at',
        'location_id',
      ]),
    );
  });

  it('excludes drafts and soft-deleted rows', () => {
    const sql = generate([version(1, [field('a', 'short_text')])])[0]!.sql;

    expect(sql).toContain("s.status <> 'draft'");
    expect(sql).toContain('s.deleted_at IS NULL');
  });

  it('casts through the non-raising helpers so one bad value cannot break the view', () => {
    const views = generate([
      version(1, [field('age', 'integer'), field('visit_date', 'date'), field('score', 'number')]),
    ]);
    const sql = views[0]!.sql;

    expect(sql).toContain('analytics.try_bigint');
    expect(sql).toContain('analytics.try_date');
    expect(sql).toContain('analytics.try_numeric');
    // A raw cast anywhere in a generated field column would defeat the point.
    expect(sql).not.toMatch(/->>'[a-z_]+'\)::/);
  });

  it('gives a choice field both a stable code and a readable label column', () => {
    const views = generate([
      version(1, [field('grade', 'single_choice', { optionSet: optionSet('grades', ['g1', 'g2']) })]),
    ]);

    expect(columnNames(views[0]!)).toEqual(expect.arrayContaining(['grade', 'grade_label']));
    expect(views[0]!.sql).toContain("WHEN 'g1' THEN 'G1'");
  });

  it('gives a multi-choice field an array column plus one boolean per option', () => {
    const views = generate([
      version(1, [field('services', 'multi_choice', { optionSet: optionSet('svc', ['anc', 'imm']) })]),
    ]);

    const columns = columnNames(views[0]!);
    expect(columns).toEqual(expect.arrayContaining(['services', 'services_anc', 'services_imm']));
    expect(views[0]!.columns.find((c) => c.name === 'services')?.pgType).toBe('text[]');
  });

  it('splits a geopoint into scalar lat/lon columns', () => {
    const views = generate([version(1, [field('house_location', 'geopoint')])]);

    expect(columnNames(views[0]!)).toEqual(
      expect.arrayContaining(['house_location_lat', 'house_location_lon', 'house_location_accuracy_m']),
    );
  });

  it('gives a repeating group its own child view keyed back to the parent', () => {
    const group = field('members', 'repeat_group', { id: 'grp' });
    const views = generate([
      version(1, [
        field('household_head', 'short_text'),
        group,
        field('member_name', 'short_text', { parentGroupId: 'grp' }),
        field('member_age', 'integer', { parentGroupId: 'grp' }),
      ]),
    ]);

    expect(views).toHaveLength(2);

    const child = views.find((v) => v.repeatGroupKey === 'members');
    expect(child?.name).toBe('school_attendance__members');
    expect(columnNames(child!)).toEqual(
      expect.arrayContaining(['entry_id', 'submission_id', 'entry_index', 'member_name', 'member_age']),
    );
    expect(child?.sql).toContain('jsonb_array_elements');
    expect(child?.sql).toContain('WITH ORDINALITY');
    // Guards a submission whose repeat key somehow is not an array.
    expect(child?.sql).toContain("jsonb_typeof(s.data->'members') = 'array'");

    // The group itself contributes no column to the parent view.
    expect(columnNames(views[0]!)).not.toContain('members');
  });

  it('tracks repeat-group membership by key across versions', () => {
    // Every publish gives the group a fresh row id, so membership must be
    // resolved by key or the child fields land on the wrong view.
    const v1 = version(1, [
      field('members', 'repeat_group', { id: 'grp-v1' }),
      field('member_name', 'short_text', { parentGroupId: 'grp-v1' }),
    ]);
    const v2 = version(2, [
      field('members', 'repeat_group', { id: 'grp-v2' }),
      field('member_name', 'short_text', { parentGroupId: 'grp-v2' }),
      field('member_age', 'integer', { parentGroupId: 'grp-v2' }),
    ]);

    const views = generate([v1, v2]);
    const child = views.find((v) => v.repeatGroupKey === 'members');

    expect(views).toHaveLength(2);
    expect(columnNames(child!)).toEqual(expect.arrayContaining(['member_name', 'member_age']));
  });

  it('de-duplicates colliding column names', () => {
    // `services` multi-choice emits `services_anc`; a separate question keyed
    // `services_anc` must not silently overwrite it.
    const views = generate([
      version(1, [
        field('services', 'multi_choice', { optionSet: optionSet('svc', ['anc']) }),
        field('services_anc', 'boolean'),
      ]),
    ]);

    const columns = columnNames(views[0]!);
    expect(new Set(columns).size).toBe(columns.length);
  });
});

describe('toSnakeCase', () => {
  /*
   * This names analytics columns, CSV headers and API properties, so what it
   * produces is read by people outside the product.
   */
  it('turns a question into a readable identifier', () => {
    expect(toSnakeCase('Date of birth')).toBe('date_of_birth');
    expect(toSnakeCase('Which class?')).toBe('which_class');
  });

  it('drops apostrophes rather than splitting on them', () => {
    // `guardian_s_phone` was the previous output, and it went straight into
    // every spreadsheet an NGO sends out.
    expect(toSnakeCase("Guardian's phone")).toBe('guardians_phone');
    expect(toSnakeCase('Child’s name')).toBe('childs_name');
  });

  it('splits camelCase, and never leaves leading or trailing underscores', () => {
    expect(toSnakeCase('guardianPhone')).toBe('guardian_phone');
    expect(toSnakeCase('  spaced out  ')).toBe('spaced_out');
    expect(toSnakeCase('--dashes--')).toBe('dashes');
  });
});

describe('describing a view without building it', () => {
  /*
   * A screen needs to know which question a column came from so it can show a
   * label instead of `guardian_phone`. The danger is not that the descriptor is
   * wrong in general — it is that it is wrong only for the forms unlucky enough
   * to have two keys that collide after `toSnakeCase`, because the second one
   * gets `_2` appended and which one that is depends on field order.
   */
  it('names exactly the columns the generator names', () => {
    const versions = [
      version(1, [
        field('full_name', 'short_text'),
        field('grade', 'single_choice', { optionSet: optionSet('grade', ['g1', 'g2']) }),
        field('dob', 'date'),
      ]),
    ];

    const described = describeMainViewColumns(versions).map((c) => c.name);
    const generated = generateFormViews({
      formId: 'form-1',
      formSlug: 'intake',
      schema: 'analytics_test',
      versions,
    })[0]!.columns.map((c) => c.name);

    expect(described).toEqual(generated);
  });

  it('agrees with the generator when two keys collide', () => {
    // `Guardian's phone` and `guardian phone` both snake-case to the same
    // thing. One of them becomes `guardians_phone_2`, and the descriptor has to
    // pick the same one — otherwise a column is labelled as the wrong question.
    const versions = [
      version(1, [
        field('guardians phone', 'short_text'),
        field("guardian's phone", 'short_text'),
      ]),
    ];

    const described = describeMainViewColumns(versions).map((c) => c.name);
    const generated = generateFormViews({
      formId: 'form-1',
      formSlug: 'collide',
      schema: 'analytics_test',
      versions,
    })[0]!.columns.map((c) => c.name);

    expect(described).toEqual(generated);
    expect(described).toContain('guardians_phone');
    expect(described).toContain('guardians_phone_2');
  });

  it('carries the question behind every answer column, and none of the fixed ones', () => {
    const versions = [version(1, [field('full_name', 'short_text', { label: { en: 'Full name' } })])];
    const columns = describeMainViewColumns(versions);

    const named = columns.find((c) => c.name === 'full_name');
    expect(named?.source).toMatchObject({ fieldKey: 'full_name', label: { en: 'Full name' } });

    // The machinery is not a question and must not pretend to be one.
    expect(columns.find((c) => c.name === 'submission_id')?.source).toBeUndefined();
    expect(columns.find((c) => c.name === 'submitted_at')?.source).toBeUndefined();
  });

  it('still describes a question that only an older version had', () => {
    const versions = [
      version(1, [field('retired', 'short_text')]),
      version(2, [field('current', 'short_text')]),
    ];
    const names = describeMainViewColumns(versions).map((c) => c.name);

    // The view keeps the column so the historical answers stay readable.
    expect(names).toContain('retired');
    expect(names).toContain('current');
  });

  it('knows the reserved view name', () => {
    expect(mainViewName('school_attendance')).toBe('school_attendance');
    // A form actually called "Subjects" cannot take the registry's view name.
    expect(mainViewName('subjects')).toBe('subjects_form');
  });
});
