/**
 * CSV, written to RFC 4180 rather than to "join with commas".
 *
 * The failure this prevents is quiet: a worker's free-text note containing a
 * comma, a quote or a line break silently shifts every later column of that
 * row. Nobody notices until an analysis is already wrong.
 */

/** Excel on Windows assumes the system codepage without this. */
export const UTF8_BOM = '﻿';

/**
 * What a spreadsheet reads as the beginning of a formula rather than of a value.
 *
 * `=`, `+` and `@` are unambiguous. A leading tab or carriage return is here
 * because some readers strip it and then look at what follows. `-` is the
 * awkward one: it begins every negative number as well as
 * `-2+3+cmd|' /C calc'!A0`, so it cannot simply be banned.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/** A value that is only a number. Nothing here can be interpreted as a call. */
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

/**
 * Escapes one field.
 *
 * Quoted whenever the value contains a delimiter, a quote, a newline, or
 * leading/trailing whitespace that a reader would otherwise strip. Embedded
 * quotes are doubled, per the spec.
 *
 * A value that would be read as a formula also gets a leading apostrophe, which
 * is how every spreadsheet is told "this is text". The content of these files
 * is free text typed by field workers into a form on a phone, and it is opened
 * by an administrator double-clicking a download — so a cell that runs
 * something on their machine is a real path from a form to a laptop, and one
 * the person opening it has no way to see coming.
 *
 * The apostrophe is visible in the cell, which is a real cost and the reason it
 * is applied as narrowly as possible: never to a number (`-5` stays `-5`), only
 * to text that a reader would otherwise try to evaluate.
 */
export function csvField(value: unknown): string {
  if (value === null || value === undefined) return '';

  const formatted = formatCell(value);
  const text =
    typeof value !== 'number' && FORMULA_LEAD.test(formatted) && !PLAIN_NUMBER.test(formatted)
      ? `'${formatted}`
      : formatted;

  const needsQuoting = /[",\r\n]/.test(text) || text !== text.trim();

  return needsQuoting ? `"${text.replaceAll('"', '""')}"` : text;
}

function formatCell(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  // A jsonb column comes back as an object; a raw `[object Object]` in a
  // spreadsheet cell is worse than useless.
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** One CSV row, CRLF-terminated as the spec requires. */
export function csvRow(values: unknown[]): string {
  return `${values.map(csvField).join(',')}\r\n`;
}
