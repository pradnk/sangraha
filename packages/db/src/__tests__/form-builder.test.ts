/**
 * The builder's promises, verified against a real database.
 *
 * The claims that matter are not "a field row was inserted" but the ones an
 * NGO would be harmed by if they turned out to be false: renaming a question
 * does not move its analytics column, publishing a change does not disturb the
 * data already collected, and the guardrails actually refuse the edits that
 * would destroy meaning.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { localise, pgIdentifier } from '@sangraha/form-engine';
import { regenerateFormViews } from '../analytics/generate';
import {
  addField,
  checkDelete,
  checkTypeChange,
  countAnswersForKey,
  createForm,
  discardDraft,
  getEditableVersion,
  getOrCreateDraft,
  isProvisionalKey,
  listFormsForAdmin,
  PLACEHOLDER_LABEL,
  publishDraft,
  resolveFieldInVersion,
  updateField,
  validateDraft,
} from '../queries/form-builder';
import { loadFormVersionById } from '../queries/form-definitions';
import { formFields, submissions } from '../schema/index';
import {
  closeHarness,
  createTestOrg,
  dropTestOrg,
  hasDatabase,
  ownerDb,
  type TestOrg,
} from './harness';

describe.skipIf(!hasDatabase)('form builder', () => {
  let org: TestOrg;

  beforeAll(async () => {
    org = await createTestOrg('builder');
  });

  afterAll(async () => {
    await dropTestOrg(org);
    await closeHarness();
  });

  /** A form with one text question, published, plus its analytics columns. */
  async function makePublishedForm(slug: string) {
    const db = ownerDb();
    const formId = await createForm(db, org.id, {
      slug,
      name: { en: slug },
      formType: 'standalone',
    });
    const draft = await getOrCreateDraft(db, formId, org.adminId);
    const fieldId = await addField(db, draft, {
      label: { en: 'Student name' },
      dataType: 'short_text',
    });
    await publishDraft(db, formId, org.adminId);
    await regenerateFormViews(db, formId);
    return { formId, fieldId };
  }

  /** The latest published version's id, for asserting it did not move. */
  const publishedVersionId = async (formId: string): Promise<string | null> => {
    const rows = (await ownerDb().execute(sql`
      SELECT id FROM form_versions
      WHERE form_id = ${formId} AND status = 'published'
      ORDER BY version_number DESC LIMIT 1
    `)) as unknown as { id: string }[];
    return rows[0]?.id ?? null;
  };

  const viewColumns = async (view: string): Promise<string[]> => {
    const rows = (await ownerDb().execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = ${org.analyticsSchema} AND table_name = ${view}
      ORDER BY ordinal_position
    `)) as unknown as { column_name: string }[];
    return rows.map((r) => r.column_name);
  };

  it('publishes a new form and generates its analytics view', async () => {
    const { formId } = await makePublishedForm('intake');

    expect(await viewColumns('intake')).toContain('student_name');

    const editable = await getEditableVersion(ownerDb(), formId);
    expect(editable?.status).toBe('published');
    expect(editable?.versionNumber).toBe(1);
  });

  describe('the key a question ends up with', () => {
    /*
     * The defect these cover: every question built through the UI is created
     * with the placeholder label "Untitled question", the key was derived from
     * that and frozen, and so a question the admin then named "Age" shipped an
     * analytics column and a CSV header called `untitled_question_2`. Nobody
     * chose that name and nobody could change it.
     */
    async function draftField(slug: string) {
      const db = ownerDb();
      const formId = await createForm(db, org.id, {
        slug,
        name: { en: slug },
        formType: 'standalone',
      });
      const versionId = await getOrCreateDraft(db, formId, org.adminId);
      const fieldId = await addField(db, versionId, {
        label: { en: PLACEHOLDER_LABEL },
        dataType: 'short_text',
      });
      return { formId, versionId, fieldId };
    }

    const keyOf = async (fieldId: string): Promise<string> => {
      const [row] = await ownerDb()
        .select({ key: formFields.key })
        .from(formFields)
        .where(eq(formFields.id, fieldId))
        .limit(1);
      return row!.key;
    };

    it('starts provisional and becomes the real label', async () => {
      const { versionId, fieldId } = await draftField('keys-basic');
      expect(await keyOf(fieldId)).toBe('untitled_question');

      // The apostrophe is dropped, not turned into a separator: this string
      // becomes a CSV header, and `guardian_s_phone` is not one to send a funder.
      await updateField(ownerDb(), versionId, fieldId, { label: { en: "Guardian's phone" } });
      expect(await keyOf(fieldId)).toBe('guardians_phone');
    });

      it('repoints a rule that depended on the key it just renamed', async () => {
      /*
       * A rule names its dependency by key, and re-deriving a provisional key
       * used to leave every rule pointing at a name that no longer existed.
       * `evaluateRule` then saw `undefined`, `visibleFields` dropped the
       * dependent question from the form *and* from validation, and a required
       * question disappeared for every field worker with nothing to show for it.
       */
      const db = ownerDb();
      const formId = await createForm(db, org.id, {
        slug: 'keys-rules',
        name: { en: 'keys-rules' },
        formType: 'standalone',
      });
      const versionId = await getOrCreateDraft(db, formId, org.adminId);

      // Two questions from the palette, both born with the placeholder label.
      const first = await addField(db, versionId, {
        label: { en: PLACEHOLDER_LABEL },
        dataType: 'short_text',
      });
      const second = await addField(db, versionId, {
        label: { en: PLACEHOLDER_LABEL },
        dataType: 'short_text',
      });

      // The second depends on the first, by the key it has right now.
      const dependencyKey = await keyOf(first);
      await updateField(db, versionId, second, {
        visibilityRule: { op: 'eq', field: dependencyKey, value: 'yes' },
      });

      // Now the admin names the first one, which re-derives its key.
      await updateField(db, versionId, first, { label: { en: "Guardian's phone" } });
      expect(await keyOf(first)).toBe('guardians_phone');

      const [dependent] = await ownerDb()
        .select({ rule: formFields.visibilityRule })
        .from(formFields)
        .where(eq(formFields.id, second));

      expect(dependent!.rule).toEqual({ op: 'eq', field: 'guardians_phone', value: 'yes' });
    });

    it('leaves alone a rule that pointed somewhere else', async () => {
      const db = ownerDb();
      const formId = await createForm(db, org.id, {
        slug: 'keys-rules-other',
        name: { en: 'keys-rules-other' },
        formType: 'standalone',
      });
      const versionId = await getOrCreateDraft(db, formId, org.adminId);
      const named = await addField(db, versionId, {
        label: { en: 'Village' },
        dataType: 'short_text',
      });
      const provisional = await addField(db, versionId, {
        label: { en: PLACEHOLDER_LABEL },
        dataType: 'short_text',
      });
      const dependent = await addField(db, versionId, {
        label: { en: 'Follow up' },
        dataType: 'short_text',
      });

      await updateField(db, versionId, dependent, {
        visibilityRule: { op: 'eq', field: 'village', value: 'Kittur' },
      });
      await updateField(db, versionId, provisional, { label: { en: 'Age' } });

      const [row] = await ownerDb()
        .select({ rule: formFields.visibilityRule })
        .from(formFields)
        .where(eq(formFields.id, dependent));
      expect(row!.rule).toEqual({ op: 'eq', field: 'village', value: 'Kittur' });
      expect(await keyOf(named)).toBe('village');
    });

  it('recognises the numbered placeholders too', () => {
      // The second and later questions on a form.
      expect(isProvisionalKey('untitled_question')).toBe(true);
      expect(isProvisionalKey('untitled_question_2')).toBe(true);
      expect(isProvisionalKey('untitled_question_11')).toBe(true);
      expect(isProvisionalKey('guardian_phone')).toBe(false);
      expect(isProvisionalKey('untitled_question_note')).toBe(false);
    });

    it('does not touch a key the admin named properly at the start', async () => {
      const db = ownerDb();
      const formId = await createForm(db, org.id, {
        slug: 'keys-named',
        name: { en: 'keys-named' },
        formType: 'standalone',
      });
      const versionId = await getOrCreateDraft(db, formId, org.adminId);
      const fieldId = await addField(db, versionId, {
        label: { en: 'Student name' },
        dataType: 'short_text',
      });

      await updateField(db, versionId, fieldId, { label: { en: 'Full name of the child' } });

      // Renaming a properly-named question must never move its column — that
      // is the invariant the placeholder case is a narrow exception to.
      expect(await keyOf(fieldId)).toBe('student_name');
    });

    it('freezes once an answer exists, even while still provisional', async () => {
      const { formId, versionId, fieldId } = await draftField('keys-answered');
      await publishDraft(ownerDb(), formId, org.adminId);

      await ownerDb()
        .insert(submissions)
        .values({
          orgId: org.id,
          formId,
          formVersionId: versionId,
          submittedBy: org.workerAId,
          clientUuid: crypto.randomUUID(),
          status: 'submitted',
          data: { untitled_question: 'already collected' },
        });

      await updateField(ownerDb(), versionId, fieldId, { label: { en: 'Renamed after the fact' } });

      // An answer is stored under the old key. Moving the key would strand it.
      expect(await keyOf(fieldId)).toBe('untitled_question');
    });

    it('does not collide with a sibling that already holds that name', async () => {
      const db = ownerDb();
      const formId = await createForm(db, org.id, {
        slug: 'keys-collide',
        name: { en: 'keys-collide' },
        formType: 'standalone',
      });
      const versionId = await getOrCreateDraft(db, formId, org.adminId);
      await addField(db, versionId, { label: { en: 'Age' }, dataType: 'integer' });
      const second = await addField(db, versionId, {
        label: { en: PLACEHOLDER_LABEL },
        dataType: 'short_text',
      });

      await updateField(db, versionId, second, { label: { en: 'Age' } });

      expect(await keyOf(second)).toBe('age_2');
    });

    it('leaves the key alone when only the placeholder is re-saved', async () => {
      const { versionId, fieldId } = await draftField('keys-placeholder');
      await updateField(ownerDb(), versionId, fieldId, { label: { en: PLACEHOLDER_LABEL } });
      expect(await keyOf(fieldId)).toBe('untitled_question');
    });

    it('leaves the key alone when the edit is not a rename', async () => {
      const { versionId, fieldId } = await draftField('keys-other-edit');
      await updateField(ownerDb(), versionId, fieldId, { isRequired: true });
      expect(await keyOf(fieldId)).toBe('untitled_question');
    });
  });

  it('keeps the analytics column when the question is reworded', async () => {
    // The single most important guarantee in the product: an admin can fix the
    // wording of a live question without anything downstream moving.
    const { formId, fieldId } = await makePublishedForm('reword');
    const before = await viewColumns('reword');

    const draft = await getOrCreateDraft(ownerDb(), formId, org.adminId);
    const [copied] = await ownerDb()
      .select({ id: formFields.id, key: formFields.key })
      .from(formFields)
      .where(eq(formFields.formVersionId, draft));

    await updateField(ownerDb(), draft, copied!.id, {
      label: { en: "The child's full name", hi: 'बच्चे का नाम' },
    });
    await publishDraft(ownerDb(), formId, org.adminId);
    await regenerateFormViews(ownerDb(), formId);

    expect(copied!.key).toBe('student_name');
    expect(copied!.id).not.toBe(fieldId); // a copy, on a new version
    expect(await viewColumns('reword')).toEqual(before);
  });

  it('adds a question without disturbing data already collected', async () => {
    const { formId } = await makePublishedForm('growing');
    const v1 = await getEditableVersion(ownerDb(), formId);

    await ownerDb().insert(submissions).values({
      orgId: org.id,
      formId,
      formVersionId: v1!.id,
      submittedBy: org.workerAId,
      clientUuid: crypto.randomUUID(),
      data: { student_name: 'Collected before the change' },
    });

    const draft = await getOrCreateDraft(ownerDb(), formId, org.adminId);
    await addField(ownerDb(), draft, { label: { en: 'Attendance percent' }, dataType: 'number' });
    await publishDraft(ownerDb(), formId, org.adminId);
    await regenerateFormViews(ownerDb(), formId);

    const rows = (await ownerDb().execute(
      sql.raw(
        `SELECT student_name, attendance_percent FROM ${pgIdentifier(org.analyticsSchema)}."growing"`,
      ),
    )) as unknown as Record<string, unknown>[];

    expect(rows).toHaveLength(1);
    expect(rows[0]?.student_name).toBe('Collected before the change');
    expect(rows[0]?.attendance_percent).toBeNull();
  });

  it('starts a draft as a copy of what is published, not from nothing', async () => {
    const { formId } = await makePublishedForm('copying');
    const draft = await getOrCreateDraft(ownerDb(), formId, org.adminId);

    const fields = await loadFormVersionById(ownerDb(), draft);
    expect(fields?.fields.map((f) => f.key)).toEqual(['student_name']);
  });

  describe('an edit made against the published version the builder rendered', () => {
    /*
     * The defect these cover, which broke the immutability of a published
     * version — the thing that keeps old answers interpretable.
     *
     * `getEditableVersion` returns the *published* version when there is no
     * draft, so that is what the builder renders and what the browser holds ids
     * for. The first edit creates a draft, copying every field under new ids,
     * and the id in the admin's hands is now stale. Unscoped, `updateField`
     * matched it anyway — on the published version — so renaming a question
     * after a publish rewrote v1 in place while the draft kept the old wording.
     */
    it('lands on the draft, and never on the published version', async () => {
      const db = ownerDb();
      const { formId, fieldId: publishedFieldId } = await makePublishedForm('stale-id');

      // Exactly what the action does: create the draft, then resolve the id the
      // browser sent against it.
      const draft = await getOrCreateDraft(db, formId, org.adminId);
      const resolved = await resolveFieldInVersion(db, draft, publishedFieldId);

      expect(resolved).not.toBeNull();
      expect(resolved).not.toBe(publishedFieldId);

      await updateField(db, draft, resolved!, { label: { en: 'Name of the child' } });

      const published = await loadFormVersionById(db, (await publishedVersionId(formId))!);
      expect(localise(published!.fields[0]!.label, 'en')).toBe('Student name');

      const edited = await loadFormVersionById(db, draft);
      expect(localise(edited!.fields[0]!.label, 'en')).toBe('Name of the child');
    });

    it('refuses to write to a version the field is not in', async () => {
      const db = ownerDb();
      const { formId, fieldId: publishedFieldId } = await makePublishedForm('scoped-write');
      const draft = await getOrCreateDraft(db, formId, org.adminId);

      // The guard behind the resolution: handed a published id and the draft's
      // version, the update must touch nothing at all rather than fall back to
      // matching on the id alone.
      await updateField(db, draft, publishedFieldId, { label: { en: 'Should not apply' } });

      const published = await loadFormVersionById(db, (await publishedVersionId(formId))!);
      expect(localise(published!.fields[0]!.label, 'en')).toBe('Student name');

      const untouched = await loadFormVersionById(db, draft);
      expect(localise(untouched!.fields[0]!.label, 'en')).toBe('Student name');
    });

    it('does not resolve a field belonging to a different form', async () => {
      const db = ownerDb();
      const { fieldId: theirs } = await makePublishedForm('other-form');
      const { formId } = await makePublishedForm('mine');
      const draft = await getOrCreateDraft(db, formId, org.adminId);

      // Both forms have a `student_name`, so matching on key alone would be a
      // cross-form write. Identity is key *within the same form*.
      expect(await resolveFieldInVersion(db, draft, theirs)).toBeNull();
    });
  });

  it('re-points repeat group children when copying a draft', async () => {
    // Group membership is by row id, and every id changes on copy. Getting this
    // wrong silently orphans the child questions.
    const db = ownerDb();
    const formId = await createForm(db, org.id, {
      slug: 'household',
      name: { en: 'household' },
      formType: 'standalone',
    });
    const first = await getOrCreateDraft(db, formId, org.adminId);
    const groupId = await addField(db, first, {
      label: { en: 'Members' },
      dataType: 'repeat_group',
    });
    await addField(db, first, {
      label: { en: 'Member name' },
      dataType: 'short_text',
      parentGroupId: groupId,
    });
    await publishDraft(db, formId, org.adminId);

    const draft = await getOrCreateDraft(db, formId, org.adminId);
    const version = await loadFormVersionById(db, draft);

    const group = version!.fields.find((f) => f.key === 'members')!;
    const child = version!.fields.find((f) => f.key === 'member_name')!;

    expect(child.parentGroupId).toBe(group.id);
    expect(child.parentGroupId).not.toBe(groupId);
  });

  it('discards a draft and leaves the published version untouched', async () => {
    const { formId } = await makePublishedForm('revertible');
    const draft = await getOrCreateDraft(ownerDb(), formId, org.adminId);
    await addField(ownerDb(), draft, { label: { en: 'Oops' }, dataType: 'short_text' });

    await discardDraft(ownerDb(), formId);

    const editable = await getEditableVersion(ownerDb(), formId);
    expect(editable?.status).toBe('published');
    const version = await loadFormVersionById(ownerDb(), editable!.id);
    expect(version?.fields.map((f) => f.key)).toEqual(['student_name']);
  });

  it('generates a distinct key rather than colliding', async () => {
    const db = ownerDb();
    const formId = await createForm(db, org.id, {
      slug: 'dupes',
      name: { en: 'dupes' },
      formType: 'standalone',
    });
    const draft = await getOrCreateDraft(db, formId, org.adminId);
    await addField(db, draft, { label: { en: 'Notes' }, dataType: 'short_text' });
    await addField(db, draft, { label: { en: 'Notes' }, dataType: 'short_text' });

    const version = await loadFormVersionById(db, draft);
    const keys = version!.fields.map((f) => f.key);

    expect(keys).toEqual(['notes', 'notes_2']);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('refuses to publish a choice question with no answers to choose from', async () => {
    const db = ownerDb();
    const formId = await createForm(db, org.id, {
      slug: 'incomplete',
      name: { en: 'incomplete' },
      formType: 'standalone',
    });
    const draft = await getOrCreateDraft(db, formId, org.adminId);
    await addField(db, draft, { label: { en: 'Which grade?' }, dataType: 'single_choice' });

    const problems = await validateDraft(db, draft);
    expect(problems.some((p) => p.message.includes('list of answers'))).toBe(true);

    const result = await publishDraft(db, formId, org.adminId);
    expect(result.ok).toBe(false);
  });

  it('refuses to publish an empty form', async () => {
    const db = ownerDb();
    const formId = await createForm(db, org.id, {
      slug: 'empty',
      name: { en: 'empty' },
      formType: 'standalone',
    });
    await getOrCreateDraft(db, formId, org.adminId);

    const result = await publishDraft(db, formId, org.adminId);
    expect(result.ok).toBe(false);
  });

  it('reports publish state and response counts on the forms list', async () => {
    /*
     * The regression this exists for: these three values were computed with
     * correlated subqueries, and Drizzle renders an interpolated column
     * unqualified. Inside a subquery over a table that also has that column
     * name, the correlation bound to the wrong table and every form reported
     * "Not published" with zero responses — silently, with the data intact
     * underneath. Nothing else asserted these numbers, so nothing caught it.
     */
    const db = ownerDb();

    const { formId } = await makePublishedForm('listed');
    const version = await getEditableVersion(db, formId);
    await db.insert(submissions).values([
      {
        orgId: org.id,
        formId,
        formVersionId: version!.id,
        submittedBy: org.workerAId,
        clientUuid: crypto.randomUUID(),
        data: { student_name: 'One' },
      },
      {
        orgId: org.id,
        formId,
        formVersionId: version!.id,
        submittedBy: org.workerAId,
        clientUuid: crypto.randomUUID(),
        data: { student_name: 'Two' },
      },
    ]);

    const neverPublishedId = await createForm(db, org.id, {
      slug: 'never_published',
      name: { en: 'never published' },
      formType: 'standalone',
    });

    const list = await listFormsForAdmin(db, org.id);
    const listed = list.find((f) => f.slug === 'listed')!;
    const never = list.find((f) => f.slug === 'never_published')!;

    expect(listed.publishedVersion).toBe(1);
    expect(listed.submissionCount).toBe(2);
    expect(listed.hasDraft).toBe(false);

    // A form with no versions at all must not look published.
    expect(never.publishedVersion).toBeNull();
    expect(never.hasDraft).toBe(false);
    expect(never.submissionCount).toBe(0);

    // An open draft is flagged without disturbing the published version.
    await getOrCreateDraft(db, formId, org.adminId);
    const afterDraft = (await listFormsForAdmin(db, org.id)).find((f) => f.slug === 'listed')!;
    expect(afterDraft.hasDraft).toBe(true);
    expect(afterDraft.publishedVersion).toBe(1);
    expect(afterDraft.submissionCount).toBe(2);

    void neverPublishedId;
  });

  it('does not inflate the response count when a form has several versions', async () => {
    // The reason submissions are counted in their own query: joining versions
    // and submissions together multiplies the rows.
    const db = ownerDb();
    const { formId } = await makePublishedForm('multiversion');

    const v1 = await getEditableVersion(db, formId);
    await db.insert(submissions).values({
      orgId: org.id,
      formId,
      formVersionId: v1!.id,
      submittedBy: org.workerAId,
      clientUuid: crypto.randomUUID(),
      data: { student_name: 'Only one' },
    });

    const draft = await getOrCreateDraft(db, formId, org.adminId);
    await addField(db, draft, { label: { en: 'Extra' }, dataType: 'short_text' });
    await publishDraft(db, formId, org.adminId);

    const listed = (await listFormsForAdmin(db, org.id)).find((f) => f.slug === 'multiversion')!;

    expect(listed.publishedVersion).toBe(2);
    expect(listed.submissionCount).toBe(1);
  });

  it('counts an answer inside a repeating section', async () => {
    /*
     * `data ? key` only ever looked at the top level, and a repeat group's
     * answers are nested — `data[groupKey]` is an array of objects with the
     * child keys inside. So a question in a repeating section always counted
     * zero, and `checkDelete` and `checkTypeChange` would clear or narrow one
     * that already held answers, which is precisely what they exist to refuse.
     */
    const db = ownerDb();
    const formId = await createForm(db, org.id, {
      slug: 'roster',
      name: { en: 'roster' },
      formType: 'standalone',
    });
    const versionId = await getOrCreateDraft(db, formId, org.adminId);
    const groupId = await addField(db, versionId, {
      label: { en: 'Members' },
      dataType: 'repeat_group',
    });
    await addField(db, versionId, {
      label: { en: 'Member name' },
      dataType: 'short_text',
      parentGroupId: groupId,
    });
    await publishDraft(db, formId, org.adminId);

    await db.insert(submissions).values({
      orgId: org.id,
      formId,
      formVersionId: versionId,
      submittedBy: org.workerAId,
      clientUuid: crypto.randomUUID(),
      status: 'submitted',
      data: { members: [{ member_name: 'Sunita' }, { member_name: 'Ramesh' }] },
    });

    expect(await countAnswersForKey(db, formId, 'member_name')).toBe(1);
    // And the guard built on it now refuses, rather than clearing the column.
    expect(checkDelete(await countAnswersForKey(db, formId, 'member_name')).allowed).toBe(false);
  });

  it('counts the answers a question already holds', async () => {
    const { formId } = await makePublishedForm('counted');
    const version = await getEditableVersion(ownerDb(), formId);

    await ownerDb().insert(submissions).values({
      orgId: org.id,
      formId,
      formVersionId: version!.id,
      submittedBy: org.workerAId,
      clientUuid: crypto.randomUUID(),
      data: { student_name: 'Someone' },
    });

    expect(await countAnswersForKey(ownerDb(), formId, 'student_name')).toBe(1);
    expect(await countAnswersForKey(ownerDb(), formId, 'never_asked')).toBe(0);
  });
});

describe('edit guardrails', () => {
  it('allows anything while the question has no answers', () => {
    expect(checkTypeChange('short_text', 'integer', 0).allowed).toBe(true);
    expect(checkDelete(0).allowed).toBe(true);
  });

  it('allows a widening change, with a warning', () => {
    const verdict = checkTypeChange('integer', 'number', 12);

    expect(verdict.allowed).toBe(true);
    expect(verdict.allowed && verdict.warning).toContain('12 answers');
  });

  it('refuses a narrowing change that would strand existing answers', () => {
    // Free text to a number is the classic one: "about 12" stops being readable.
    const verdict = checkTypeChange('short_text', 'integer', 12);

    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.reason).toContain('12 answers');
    expect(verdict.allowed === false && verdict.reason).toMatch(/archive/i);
  });

  it('refuses to turn a repeating section into an ordinary question', () => {
    expect(checkTypeChange('repeat_group', 'short_text', 3).allowed).toBe(false);
    expect(checkTypeChange('short_text', 'repeat_group', 3).allowed).toBe(false);
  });

  it('refuses to delete a question holding answers, and says what to do instead', () => {
    const verdict = checkDelete(23);

    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.reason).toContain('23 answers');
    expect(verdict.allowed === false && verdict.reason).toMatch(/archive it instead/i);
  });

  it('phrases refusals for the person reading them', () => {
    // These strings go straight onto the screen, so no jargon and no field keys.
    const verdict = checkDelete(5);
    const reason = verdict.allowed === false ? verdict.reason : '';

    expect(reason).not.toMatch(/null|column|schema|jsonb|constraint/i);
    expect(reason).toMatch(/reports/i);
  });
});
