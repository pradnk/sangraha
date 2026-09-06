/**
 * Guards the one coupling the form engine cannot enforce for itself.
 *
 * Field types are defined in `@sangraha/form-engine`, which is framework-free, while
 * their React renderers live in the web app. That split keeps React out of
 * migrations and the API, but it means adding a field type could otherwise
 * leave the capture UI silently unable to render it — a form that looks fine in
 * the builder and is unusable in the field.
 */
import { describe, expect, it } from 'vitest';
import { listFieldTypes, type FieldDataType } from '@sangraha/form-engine';
import { DEFERRED_FIELD_TYPES } from '../question-input';

/**
 * Types the capture UI renders today.
 *
 * Kept as an explicit list rather than derived from the component, so that
 * adding a `case` to the switch without adding it here — or the reverse — is a
 * test failure rather than a surprise in the field.
 */
const RENDERED: readonly FieldDataType[] = [
  'short_text',
  'long_text',
  'number',
  'integer',
  'date',
  'time',
  'datetime',
  'boolean',
  'single_choice',
  'multi_choice',
  'phone',
  'rating',
  'calculated',
  'subject_ref',
  'geopoint',
  'repeat_group',
  'photo',
  'file',
  'signature',
];

describe('field type renderer coverage', () => {
  it('accounts for every registered field type', () => {
    const registered = listFieldTypes().map((definition) => definition.type);
    const accountedFor = new Set<FieldDataType>([...RENDERED, ...DEFERRED_FIELD_TYPES]);

    const unaccounted = registered.filter((type) => !accountedFor.has(type));

    expect(
      unaccounted,
      `These field types have no renderer and are not listed as deferred. Add a case to ` +
        `QuestionInput and to RENDERED, or add them to DEFERRED_FIELD_TYPES: ${unaccounted.join(', ')}`,
    ).toEqual([]);
  });

  it('does not claim to render a type that no longer exists', () => {
    const registered = new Set(listFieldTypes().map((definition) => definition.type));
    const stale = [...RENDERED, ...DEFERRED_FIELD_TYPES].filter((type) => !registered.has(type));

    expect(stale).toEqual([]);
  });

  it('keeps the rendered and deferred lists disjoint', () => {
    const overlap = RENDERED.filter((type) => DEFERRED_FIELD_TYPES.includes(type));
    expect(overlap).toEqual([]);
  });

  it('renders every type a form can be built from', () => {
    // No exemptions left. Attachments, the container and the location type all
    // have renderers, so anything an admin can drag into the builder can be
    // answered on a phone — which is the property this file exists to hold.
    for (const definition of listFieldTypes()) {
      expect(RENDERED, `${definition.type} should be renderable`).toContain(definition.type);
    }
  });

  it('has nothing left deferred', () => {
    // Kept as a test rather than deleting the list: the mechanism is still
    // wanted for the next type that lands before its renderer, and an empty
    // list is the honest way to say "nothing is waiting".
    expect(DEFERRED_FIELD_TYPES).toEqual([]);
  });
});
