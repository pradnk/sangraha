import type { FieldDataType } from '../types';
import type { TextFormat } from '../text-formats';
import { checkTextFormat } from '../text-formats';
import { column, type SheetTable } from './table';

/**
 * Guessing what each column is.
 *
 * Every guess is shown to the administrator with the evidence behind it and is
 * overridable, which is what lets this be useful rather than merely clever: a
 * wrong guess that somebody can see and correct costs a click, and a wrong
 * guess applied silently corrupts a ten-year migration.
 *
 * So the rules below lean towards **text** whenever the evidence is thin. Text
 * accepts anything, and widening a question's type later is allowed while
 * narrowing it is not — being too cautious is recoverable in a way that being
 * too clever is not.
 */

export interface ColumnGuess {
  header: string;
  index: number;
  dataType: FieldDataType;
  /** Set when the type is text with a particular shape. */
  format?: TextFormat;
  /** Distinct values, when the column becomes a list to choose from. */
  choices?: string[];
  /** Values that do not fit the guess, with their 1-based row numbers. */
  misfits: { row: number; value: string }[];
  blanks: number;
  /** Distinct non-blank values. */
  distinct: number;
  /** A few real values, so the admin can judge the guess for themselves. */
  samples: string[];
  /** True when no value repeats and none is blank — a candidate identifier. */
  looksUnique: boolean;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const DMY = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/;
const INTEGER = /^-?\d+$/;
const DECIMAL = /^-?\d+\.\d+$/;
const PHONE = /^(\+?91[\s-]?)?[6-9]\d{9}$/;

/**
 * Whether these parts name a day that exists.
 *
 * The regexes above decide shape, and shape is not enough: `2026-13-45` matches
 * `ISO_DATE` and `12/25/2020` matches `DMY`. Day-first is the right reading for
 * India and is not in question here — the gap was that nothing checked the
 * reading was *possible*, so a US-formatted column was written to the database
 * as `2020-25-12`. An impossible date string is worse than a rejected one: it
 * stores clean, and `analytics.try_date` then quietly drops it, so the cell
 * disappears from the report without ever appearing in the list of cells the
 * import screen promises to show.
 */
function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export interface DateParts {
  year: number;
  month: number;
  day: number;
}

/** A `dd/mm/yyyy` cell, read day-first, that is also a real date. */
function dmyParts(value: string): DateParts | null {
  const match = DMY.exec(value.trim());
  if (!match) return null;
  const [, d, m, y] = match;
  const parts = { year: Number(y), month: Number(m), day: Number(d) };
  return isRealDate(parts.year, parts.month, parts.day) ? parts : null;
}

/** A `yyyy-mm-dd` cell that is also a real date. */
function isoParts(value: string): DateParts | null {
  const text = value.trim();
  if (!ISO_DATE.test(text)) return null;
  const parts = {
    year: Number(text.slice(0, 4)),
    month: Number(text.slice(5, 7)),
    day: Number(text.slice(8, 10)),
  };
  return isRealDate(parts.year, parts.month, parts.day) ? parts : null;
}

/** A cell this system can read as a date at all, in either notation. */
export function readDate(value: string): DateParts | null {
  return isoParts(value) ?? dmyParts(value);
}

/**
 * A `yyyy-mm-ddThh:mm` cell whose date half is also real.
 *
 * Same gap as above: `ISO_DATETIME` constrains the hours and minutes but says
 * nothing about whether the day exists.
 */
function isRealDateTime(value: string): boolean {
  const text = value.trim();
  return ISO_DATETIME.test(text) && isoParts(text.slice(0, 10)) !== null;
}

const TRUE_WORDS = new Set(['yes', 'y', 'true', '1', 'haan', 'हाँ', 'ಹೌದು']);
const FALSE_WORDS = new Set(['no', 'n', 'false', '0', 'nahi', 'नहीं', 'ಇಲ್ಲ']);

/**
 * At most this many distinct values before a column stops looking like a list.
 *
 * A "Which district?" column has a handful; a "Notes" column has as many as
 * there are rows. Fifteen is generous enough for a district or a class and
 * small enough that free text never trips it.
 */
const MAX_CHOICES = 15;

/** A value must repeat this often, on average, before it is a list. */
const MIN_REPETITION = 2;

const nonBlank = (values: string[]) => values.filter((v) => v.trim() !== '');

/**
 * Formats whose values are indistinguishable from an ordinary number.
 *
 * A column of `560001` is a valid pincode and a valid quantity, and nothing in
 * the values can settle it. The heading can: somebody who wrote "Pincode" at
 * the top of the column has already told us. Used only as a tiebreak — the
 * values still have to match, so a column headed "Pincode" full of nonsense
 * stays text.
 */
const HEADER_HINTS: { format: 'pincode' | 'aadhaar'; test: RegExp }[] = [
  { format: 'pincode', test: /\b(pin\s*-?\s*code|pincode|postal|zip)\b/i },
  { format: 'aadhaar', test: /\b(aadhaar|aadhar|adhaar|uid)\b/i },
];

function hintedFormat(header: string, filled: string[]): TextFormat | null {
  for (const hint of HEADER_HINTS) {
    if (!hint.test.test(header)) continue;
    if (allMatch(filled, (v) => checkTextFormat(v, hint.format).ok)) return hint.format;
  }
  return null;
}

/** Every value matches, and there is enough evidence to believe it. */
function allMatch(values: string[], test: (value: string) => boolean): boolean {
  return values.length > 0 && values.every(test);
}

export function inferColumn(table: SheetTable, index: number): ColumnGuess {
  const header = table.headers[index] ?? '';
  const values = column(table, index);
  const filled = nonBlank(values);
  const blanks = values.length - filled.length;
  const distinctValues = new Set(filled.map((v) => v.toLowerCase()));

  const base = {
    header,
    index,
    blanks,
    distinct: distinctValues.size,
    samples: [...new Set(filled)].slice(0, 3),
    // Worth offering the unique rule for, but only if there is something to be
    // unique about: a column of one repeated value is not an identifier.
    looksUnique: filled.length > 1 && distinctValues.size === filled.length && blanks === 0,
  };

  const decided = decide(header, filled, distinctValues);

  return {
    ...base,
    ...decided,
    misfits: findMisfits(values, decided),
  };
}

type Decision = Pick<ColumnGuess, 'dataType' | 'format' | 'choices'>;

function decide(header: string, filled: string[], distinctValues: Set<string>): Decision {
  if (filled.length === 0) return { dataType: 'short_text' };

  // Before the number rules, because these formats *are* numbers and only the
  // heading can tell them apart from a quantity.
  const hinted = hintedFormat(header, filled);
  if (hinted) return { dataType: 'short_text', format: hinted };

  if (allMatch(filled, (v) => TRUE_WORDS.has(v.toLowerCase()) || FALSE_WORDS.has(v.toLowerCase()))) {
    return { dataType: 'boolean' };
  }

  if (allMatch(filled, (v) => isRealDateTime(v))) return { dataType: 'datetime' };
  /*
   * Every value has to be a date that exists, not merely one that is shaped
   * like one. A column of `12/25/2020` fails here and falls through to text,
   * which is the right answer: the alternative is to guess month-first for a
   * column that might be either, and a guess that silently reorders somebody's
   * birth dates is the failure this whole function leans away from.
   */
  if (allMatch(filled, (v) => readDate(v) !== null)) return { dataType: 'date' };

  if (allMatch(filled, (v) => INTEGER.test(v))) {
    /*
     * A long run of digits is an identifier, not a quantity. Stored as a number
     * it loses its leading zeros and, past 15 digits, its last digits too —
     * which is how phone numbers and Aadhaar numbers get quietly corrupted by
     * spreadsheet imports.
     */
    const longest = Math.max(...filled.map((v) => v.replace('-', '').length));
    if (longest >= 10 || filled.some((v) => /^0\d/.test(v))) {
      if (allMatch(filled, (v) => PHONE.test(v))) return { dataType: 'phone' };
      return { dataType: 'short_text' };
    }
    return { dataType: 'integer' };
  }

  if (allMatch(filled, (v) => INTEGER.test(v) || DECIMAL.test(v))) return { dataType: 'number' };

  if (allMatch(filled, (v) => PHONE.test(v))) return { dataType: 'phone' };

  for (const format of ['email', 'url', 'pan', 'aadhaar', 'pincode', 'ifsc'] as const) {
    if (allMatch(filled, (v) => checkTextFormat(v, format).ok)) {
      return { dataType: 'short_text', format };
    }
  }

  /*
   * A short list of values that keep recurring is a question with fixed
   * answers. Requiring repetition matters: forty rows with forty different
   * names is not a list of forty choices.
   */
  if (
    distinctValues.size >= 2 &&
    distinctValues.size <= MAX_CHOICES &&
    filled.length >= distinctValues.size * MIN_REPETITION
  ) {
    const choices: string[] = [];
    const seen = new Set<string>();
    for (const value of filled) {
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      choices.push(value);
    }
    return { dataType: 'single_choice', choices: choices.sort((a, b) => a.localeCompare(b)) };
  }

  const longest = Math.max(...filled.map((v) => v.length));
  return { dataType: longest > 120 ? 'long_text' : 'short_text' };
}

/**
 * Values that will not survive the guessed type.
 *
 * Reported per row so the admin can go and look, rather than being told that
 * "some rows" are wrong. Capped, because a column guessed badly could otherwise
 * produce a list as long as the file.
 */
function findMisfits(values: string[], decision: Decision): ColumnGuess['misfits'] {
  const misfits: ColumnGuess['misfits'] = [];

  values.forEach((raw, i) => {
    if (misfits.length >= 20) return;
    const value = raw.trim();
    if (value === '') return;
    if (!fits(value, decision)) misfits.push({ row: i + 1, value });
  });

  return misfits;
}

export function fits(value: string, decision: Decision): boolean {
  switch (decision.dataType) {
    case 'boolean':
      return TRUE_WORDS.has(value.toLowerCase()) || FALSE_WORDS.has(value.toLowerCase());
    case 'date':
      return readDate(value) !== null;
    case 'datetime':
      return isRealDateTime(value);
    case 'integer':
      return INTEGER.test(value);
    case 'number':
      return INTEGER.test(value) || DECIMAL.test(value);
    case 'phone':
      return PHONE.test(value);
    case 'single_choice':
      return (decision.choices ?? []).some((c) => c.toLowerCase() === value.toLowerCase());
    case 'short_text':
    case 'long_text':
      return decision.format ? checkTextFormat(value, decision.format).ok : true;
    default:
      return true;
  }
}

/**
 * Converts a spreadsheet cell into the shape the field type stores.
 *
 * Returns `null` for anything that will not convert, which the caller leaves
 * blank on that row and reports — a ten-year spreadsheet always has a few cells
 * reading "not known", and refusing the whole migration over them would stop it
 * dead.
 */
export function toAnswer(value: string, decision: Decision): unknown | null {
  const text = value.trim();
  if (text === '') return null;
  if (!fits(text, decision)) return null;

  switch (decision.dataType) {
    case 'boolean':
      return TRUE_WORDS.has(text.toLowerCase());
    case 'integer':
      return Number.parseInt(text, 10);
    case 'number':
      return Number.parseFloat(text);
    case 'date': {
      // Day-first, because that is how it is written across India — and a
      // column of `03/04/1998` read as March would be wrong for most of it.
      // `fits` above has already refused anything that is not a real date, so
      // this cannot produce `2020-25-12`.
      const parts = readDate(text);
      if (!parts) return null;
      const pad = (n: number) => String(n).padStart(2, '0');
      return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
    }
    case 'datetime':
      return text.replace(' ', 'T');
    default:
      return text;
  }
}

export function inferTable(table: SheetTable): ColumnGuess[] {
  return table.headers.map((_, index) => inferColumn(table, index));
}

/** Rows that are identical to an earlier row, by 1-based row number. */
export function findDuplicateRows(table: SheetTable): number[] {
  const seen = new Map<string, number>();
  const duplicates: number[] = [];

  table.rows.forEach((row, i) => {
    const key = row.map((cell) => cell.trim().toLowerCase()).join(' ');
    if (key.replace(/ /g, '') === '') return;
    if (seen.has(key)) duplicates.push(i + 1);
    else seen.set(key, i + 1);
  });

  return duplicates;
}
