/**
 * Telling whether the person a record is about is a child.
 *
 * The Act treats getting this wrong as its most serious failure, so the
 * properties worth pinning down are the ones that fail *open*: an unknown age
 * that quietly becomes an adult, or a birthday that lands a day early.
 */
import { describe, expect, it } from 'vitest';
import { ageInYears, needsReconsentAtMajority, resolveMinorStatus } from '../minor';
import { evaluateCalc } from '../calc';

const AS_OF = new Date('2026-08-07T00:00:00Z');

describe('resolving whether someone is a minor', () => {
  const nominations = { dateOfBirthField: 'dob', ageYearsField: 'age' };

  it('prefers a birth date, and says so', () => {
    expect(resolveMinorStatus(nominations, { dob: '2015-03-01' }, AS_OF)).toEqual({
      isMinor: true,
      basis: 'dob',
      ageYears: 11,
    });
  });

  it('falls back to a recorded age where no birth date exists', () => {
    // Very common in rural registration: "age: 7" and nothing more.
    expect(resolveMinorStatus(nominations, { age: 7 }, AS_OF)).toMatchObject({
      isMinor: true,
      basis: 'age_field',
    });
    expect(resolveMinorStatus(nominations, { age: '25' }, AS_OF)).toMatchObject({
      isMinor: false,
      basis: 'age_field',
    });
  });

  it('prefers the birth date even when both are present', () => {
    // An age recorded three years ago says the person was seven *then*.
    // Treating it as current is how a child ages backwards out of protection.
    expect(resolveMinorStatus(nominations, { dob: '2000-01-01', age: 7 }, AS_OF)).toMatchObject({
      basis: 'dob',
      isMinor: false,
    });
  });

  it('never guesses adult', () => {
    /*
     * The one that matters. Failing open here means collecting a child's data
     * with no guardian anywhere in the record and nothing saying so.
     */
    for (const answers of [{}, { dob: '' }, { dob: 'not a date' }, { age: '' }, { age: 'x' }]) {
      expect(resolveMinorStatus(nominations, answers, AS_OF)).toEqual({
        isMinor: null,
        basis: 'unknown',
        ageYears: null,
      });
    }
  });

  it('is unknown when nothing was nominated at all', () => {
    // A dangling or absent nomination must not read as "everyone is an adult".
    expect(resolveMinorStatus({}, { dob: '2015-03-01' }, AS_OF)).toMatchObject({
      isMinor: null,
      basis: 'unknown',
    });
  });

  it('turns eighteen on the birthday, not a day either side', () => {
    const on = (dob: string) => resolveMinorStatus(nominations, { dob }, AS_OF).isMinor;

    // Eighteen years to the day: an adult.
    expect(on('2008-08-07')).toBe(false);
    // One day short: still a child, and still owed a guardian.
    expect(on('2008-08-08')).toBe(true);
  });

  it('ignores a birth date in the future rather than reporting a negative age', () => {
    expect(resolveMinorStatus(nominations, { dob: '2030-01-01' }, AS_OF)).toMatchObject({
      basis: 'unknown',
    });
  });
});

describe('the age arithmetic has one definition', () => {
  it('matches the calculated field exactly', () => {
    /*
     * `age_years` in a form and "is this a child" must never disagree. A second
     * implementation is off by one across a birthday — and the people it would
     * be wrong about are exactly the ones on the boundary that decides whether
     * guardian consent is required.
     */
    const dob = '2008-08-07';
    const viaCalc = evaluateCalc(
      { op: 'age_years', date: { op: 'field', key: 'dob' } },
      { dob },
    );

    expect(ageInYears(new Date(dob), new Date())).toBe(viaCalc);
  });
});

describe('turning eighteen', () => {
  it('ends a guardian’s authority, without invalidating what they did', () => {
    /*
     * What a guardian agreed to on behalf of a twelve-year-old was properly
     * given. It simply stops being theirs to keep giving.
     */
    expect(needsReconsentAtMajority('guardian_consent', '2008-08-07', AS_OF)).toBe(true);
    expect(needsReconsentAtMajority('guardian_consent', '2008-08-08', AS_OF)).toBe(false);
  });

  it('does not apply to consent the person gave themselves', () => {
    expect(needsReconsentAtMajority('consent', '2000-01-01', AS_OF)).toBe(false);
  });

  it('cannot fire without a birth date', () => {
    // Derived from the clock, so an unknown birth date simply never triggers.
    // That gap is real and is why the consent screen asks directly.
    expect(needsReconsentAtMajority('guardian_consent', null, AS_OF)).toBe(false);
  });
});
