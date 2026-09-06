/**
 * Answer lists.
 *
 * The property that matters: an option's `code` is its identity in every
 * submission ever recorded, so relabelling must not touch it and retiring must
 * not orphan the answers already given.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addOption,
  countAnswersForOption,
  createOptionSet,
  getOptionSet,
  listOptionSets,
  reorderOptions,
  setOptionActive,
  updateOptionLabel,
} from '../queries/option-sets';
import { addField, createForm, getOrCreateDraft, publishDraft } from '../queries/form-builder';
import { submissions } from '../schema/index';
import {
  closeHarness,
  createTestOrg,
  dropTestOrg,
  hasDatabase,
  ownerDb,
  type TestOrg,
} from './harness';

describe.skipIf(!hasDatabase)('option lists', () => {
  let org: TestOrg;

  beforeAll(async () => {
    org = await createTestOrg('options');
  });

  afterAll(async () => {
    await dropTestOrg(org);
    await closeHarness();
  });

  it('derives a stable code from the label', async () => {
    const setId = await createOptionSet(ownerDb(), org.id, { en: 'Reason for absence' });
    await addOption(ownerDb(), setId, { en: 'Household work' });

    const set = await getOptionSet(ownerDb(), org.id, setId);

    expect(set?.code).toBe('reason_for_absence');
    expect(set?.options[0]?.code).toBe('household_work');
  });

  it('keeps the code when the label is changed or translated', async () => {
    // An admin fixing wording must not silently split one answer into two in
    // next quarter\'s report.
    const setId = await createOptionSet(ownerDb(), org.id, { en: 'Relabelled' });
    const optionId = await addOption(ownerDb(), setId, { en: 'Illness' });

    await updateOptionLabel(ownerDb(), optionId, { en: 'Was unwell', hi: 'बीमारी', kn: 'ಅನಾರೋಗ್ಯ' });

    const set = await getOptionSet(ownerDb(), org.id, setId);
    const option = set!.options.find((o) => o.id === optionId)!;

    expect(option.code).toBe('illness');
    expect(option.label.en).toBe('Was unwell');
    expect(option.label.kn).toBe('ಅನಾರೋಗ್ಯ');
  });

  it('gives colliding labels distinct codes', async () => {
    const setId = await createOptionSet(ownerDb(), org.id, { en: 'Dupes' });
    await addOption(ownerDb(), setId, { en: 'Other' });
    await addOption(ownerDb(), setId, { en: 'Other' });

    const set = await getOptionSet(ownerDb(), org.id, setId);
    const codes = set!.options.map((o) => o.code);

    expect(codes).toEqual(['other', 'other_2']);
  });

  it('retires an option without touching the answers given against it', async () => {
    const setId = await createOptionSet(ownerDb(), org.id, { en: 'Retiring' });
    const optionId = await addOption(ownerDb(), setId, { en: 'Migration' });

    const formId = await createForm(ownerDb(), org.id, {
      slug: 'retire_form',
      name: { en: 'retire' },
      formType: 'standalone',
    });
    const draft = await getOrCreateDraft(ownerDb(), formId, org.adminId);
    await addField(ownerDb(), draft, {
      label: { en: 'Why absent?' },
      dataType: 'single_choice',
      optionSetId: setId,
    });
    await publishDraft(ownerDb(), formId, org.adminId);

    const [version] = [draft];
    await ownerDb().insert(submissions).values({
      orgId: org.id,
      formId,
      formVersionId: version,
      submittedBy: org.workerAId,
      clientUuid: crypto.randomUUID(),
      data: { why_absent: 'migration' },
    });

    expect(await countAnswersForOption(ownerDb(), org.id, setId, 'migration')).toBe(1);

    await setOptionActive(ownerDb(), optionId, false);

    // Still recorded, still countable — just no longer offered.
    expect(await countAnswersForOption(ownerDb(), org.id, setId, 'migration')).toBe(1);
    const set = await getOptionSet(ownerDb(), org.id, setId);
    expect(set!.options.find((o) => o.id === optionId)?.isActive).toBe(false);
  });

  it('counts an option used inside a multi-select answer', async () => {
    const setId = await createOptionSet(ownerDb(), org.id, { en: 'Services' });
    await addOption(ownerDb(), setId, { en: 'Antenatal' });

    const formId = await createForm(ownerDb(), org.id, {
      slug: 'multi_form',
      name: { en: 'multi' },
      formType: 'standalone',
    });
    const draft = await getOrCreateDraft(ownerDb(), formId, org.adminId);
    await addField(ownerDb(), draft, {
      label: { en: 'Services given' },
      dataType: 'multi_choice',
      optionSetId: setId,
    });
    await publishDraft(ownerDb(), formId, org.adminId);

    await ownerDb().insert(submissions).values({
      orgId: org.id,
      formId,
      formVersionId: draft,
      submittedBy: org.workerAId,
      clientUuid: crypto.randomUUID(),
      data: { services_given: ['antenatal', 'immunisation'] },
    });

    expect(await countAnswersForOption(ownerDb(), org.id, setId, 'antenatal')).toBe(1);
    expect(await countAnswersForOption(ownerDb(), org.id, setId, 'never_used')).toBe(0);
  });

  it('counts an option used inside a repeating section', async () => {
    /*
     * The predicate only ever looked at `data -> key` at the top level, and a
     * repeat group's answers are nested. So a single-choice question inside a
     * repeating section counted zero uses, `deleteOptionAction` saw the option
     * as unused and hard-deleted it — leaving every stored answer in that group
     * holding a code with no label, which is the exact outcome this guard is
     * for.
     */
    const setId = await createOptionSet(ownerDb(), org.id, { en: 'Relationship' });
    await addOption(ownerDb(), setId, { en: 'Mother' });

    const formId = await createForm(ownerDb(), org.id, {
      slug: 'household_form',
      name: { en: 'household' },
      formType: 'standalone',
    });
    const draft = await getOrCreateDraft(ownerDb(), formId, org.adminId);
    const groupId = await addField(ownerDb(), draft, {
      label: { en: 'Members' },
      dataType: 'repeat_group',
    });
    await addField(ownerDb(), draft, {
      label: { en: 'Relation' },
      dataType: 'single_choice',
      optionSetId: setId,
      parentGroupId: groupId,
    });
    await publishDraft(ownerDb(), formId, org.adminId);

    await ownerDb().insert(submissions).values({
      orgId: org.id,
      formId,
      formVersionId: draft,
      submittedBy: org.workerAId,
      clientUuid: crypto.randomUUID(),
      data: { members: [{ relation: 'mother' }, { relation: 'mother' }] },
    });

    expect(await countAnswersForOption(ownerDb(), org.id, setId, 'mother')).toBe(1);
    expect(await countAnswersForOption(ownerDb(), org.id, setId, 'never_used')).toBe(0);
  });

  it('reorders options', async () => {
    const setId = await createOptionSet(ownerDb(), org.id, { en: 'Ordered' });
    const a = await addOption(ownerDb(), setId, { en: 'First' });
    const b = await addOption(ownerDb(), setId, { en: 'Second' });

    await reorderOptions(ownerDb(), setId, [b, a]);

    const set = await getOptionSet(ownerDb(), org.id, setId);
    expect(set!.options.map((o) => o.code)).toEqual(['second', 'first']);
  });

  it('reports how many questions use a list', async () => {
    const setId = await createOptionSet(ownerDb(), org.id, { en: 'Shared list' });
    await addOption(ownerDb(), setId, { en: 'Yes really' });

    const formId = await createForm(ownerDb(), org.id, {
      slug: 'usage_form',
      name: { en: 'usage' },
      formType: 'standalone',
    });
    const draft = await getOrCreateDraft(ownerDb(), formId, org.adminId);
    await addField(ownerDb(), draft, {
      label: { en: 'One' },
      dataType: 'single_choice',
      optionSetId: setId,
    });
    await addField(ownerDb(), draft, {
      label: { en: 'Two' },
      dataType: 'single_choice',
      optionSetId: setId,
    });

    const sets = await listOptionSets(ownerDb(), org.id);
    expect(sets.find((s) => s.id === setId)?.usedByFieldCount).toBe(2);
  });
});
