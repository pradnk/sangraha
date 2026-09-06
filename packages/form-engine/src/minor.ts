import type { SubmissionData } from './types';

/**
 * Whether the person a record is about is a child.
 *
 * The Act requires verifiable guardian consent for anyone under eighteen, and
 * treats getting it wrong as its most serious failure. That makes this one
 * function load-bearing in a way little else here is.
 *
 * Two rules follow from that:
 *
 * **Never default to adult.** An unknown age is `unknown`, not "probably fine".
 * Failing open here means quietly collecting children's data with no guardian
 * anywhere in the record, which is the exact harm the section exists to
 * prevent.
 *
 * **Record how you know, not just what you concluded.** A date of birth on file
 * and a worker's say-so are both legitimate answers to "is she a minor", and
 * they are not the same answer when somebody asks how you knew.
 */

export const MAJORITY_AGE = 18;

export type MinorBasis = 'dob' | 'age_field' | 'worker_declared' | 'unknown';

export interface MinorStatus {
  /** Null when nothing on file settles it. Never coerced to false. */
  isMinor: boolean | null;
  basis: MinorBasis;
  /** Present when an age could be worked out at all. */
  ageYears: number | null;
}

export interface MinorFieldNominations {
  dateOfBirthField?: string | null;
  ageYearsField?: string | null;
}

/**
 * Whole years between a birth date and a moment, in UTC.
 *
 * Shared with the `age_years` calculated field rather than reimplemented — an
 * independent copy will be off by one across a birthday, and the children it is
 * wrong about are precisely the ones on the boundary this exists to find.
 */
export function ageInYears(birth: Date, asOf: Date): number | null {
  if (Number.isNaN(birth.getTime())) return null;

  let age = asOf.getUTCFullYear() - birth.getUTCFullYear();
  const monthDelta = asOf.getUTCMonth() - birth.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && asOf.getUTCDate() < birth.getUTCDate())) age -= 1;

  return age < 0 ? null : age;
}

/**
 * Works out whether a set of answers describes a child.
 *
 * Resolution order is date of birth, then a recorded age, then unknown. A birth
 * date is preferred because it stays true: an age recorded three years ago says
 * the person was seven then, not now, and treating it as current is how a child
 * ages backwards out of protection.
 */
export function resolveMinorStatus(
  nominations: MinorFieldNominations,
  answers: SubmissionData,
  asOf: Date = new Date(),
): MinorStatus {
  const dobKey = nominations.dateOfBirthField;
  if (dobKey) {
    const raw = answers[dobKey];
    if (typeof raw === 'string' && raw !== '') {
      const age = ageInYears(new Date(raw), asOf);
      if (age !== null) return { isMinor: age < MAJORITY_AGE, basis: 'dob', ageYears: age };
    }
  }

  const ageKey = nominations.ageYearsField;
  if (ageKey) {
    const raw = answers[ageKey];
    const age = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
    if (Number.isFinite(age) && age >= 0) {
      return { isMinor: age < MAJORITY_AGE, basis: 'age_field', ageYears: Math.floor(age) };
    }
  }

  return { isMinor: null, basis: 'unknown', ageYears: null };
}

/**
 * Whether a guardian's consent has stopped being theirs to give.
 *
 * Derived from the clock rather than fired by a scheduled job. There is no job
 * runner in this system, and an expiry that depends on one is an expiry that
 * never happens on a self-hosted server nobody has configured — whereas this is
 * correct on every deployment the instant midnight passes.
 *
 * Note this is about authority, not about the consent having been invalid. What
 * a guardian agreed to on behalf of a twelve-year-old was properly given; it
 * simply is not theirs to keep giving once she is eighteen.
 */
export function needsReconsentAtMajority(
  basis: 'consent' | 'guardian_consent' | string,
  dateOfBirth: string | null,
  asOf: Date = new Date(),
): boolean {
  if (basis !== 'guardian_consent') return false;
  if (!dateOfBirth) return false;

  const age = ageInYears(new Date(dateOfBirth), asOf);
  return age !== null && age >= MAJORITY_AGE;
}
