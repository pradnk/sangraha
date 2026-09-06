/**
 * Text formats, and the mask that replaces letting administrators write
 * regular expressions.
 *
 * The rules here decide whether a field worker's answer is accepted, so being
 * too strict is not the safe side: a real email address refused in a village
 * with no signal is data that never gets collected.
 */
import { describe, expect, it } from 'vitest';
import {
  checkTextFormat,
  formatExample,
  isValidMask,
  matchesMask,
} from '../text-formats';
import { validateSubmission } from '../validation';
import { field, version } from './fixtures';

describe('masks', () => {
  it('matches letters, digits and literals in place', () => {
    expect(matchesMask('ABCDE1234F', 'AAAAA9999A')).toBe(true);
    expect(matchesMask('HDFC0001234', 'AAAA0999999')).toBe(true);
    expect(matchesMask('1234 5678 9012', '9999 9999 9999')).toBe(true);
    // The spaces are literal: an Aadhaar typed without them does not match.
    expect(matchesMask('123456789012', '9999 9999 9999')).toBe(false);
  });

  it('is not case sensitive about letters', () => {
    // A worker typing in lower case has not made a mistake.
    expect(matchesMask('abcde1234f', 'AAAAA9999A')).toBe(true);
  });

  it('rejects the wrong length, the wrong kind and a missing literal', () => {
    expect(matchesMask('ABCDE1234', 'AAAAA9999A')).toBe(false);
    expect(matchesMask('ABCDE1234FG', 'AAAAA9999A')).toBe(false);
    expect(matchesMask('ABCD01234F', 'AAAAA9999A')).toBe(false);
    expect(matchesMask('1234-5678', '9999/9999')).toBe(false);
  });

  it('ignores surrounding space', () => {
    expect(matchesMask('  ABCDE1234F ', 'AAAAA9999A')).toBe(true);
  });

  it('accepts only masks an administrator cannot get badly wrong', () => {
    expect(isValidMask('AAAAA9999A')).toBe(true);
    expect(isValidMask('99/99-AA')).toBe(true);

    expect(isValidMask('')).toBe(false);
    expect(isValidMask('   ')).toBe(false);
    // No placeholder at all is a literal string, not a format.
    expect(isValidMask('-----')).toBe(false);
    // Regex characters are not literals here; allowing them would suggest a
    // power the mask does not have.
    expect(isValidMask('^[A-Z]{5}$')).toBe(false);
    expect(isValidMask('A'.repeat(41))).toBe(false);
  });

  it('cannot be made to backtrack, however the mask is written', () => {
    // The reason masks exist instead of regular expressions. A pattern that
    // would hang a regex engine costs exactly one pass here.
    const nasty = 'A'.repeat(40);
    const started = Date.now();
    for (let i = 0; i < 20_000; i += 1) matchesMask('x'.repeat(40), nasty);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('built-in formats', () => {
  const check = (value: string, format: Parameters<typeof checkTextFormat>[1]) =>
    checkTextFormat(value, format).ok;

  it('accepts ordinary email addresses', () => {
    expect(check('rahul@ngo.org', 'email')).toBe(true);
    expect(check('a.b+tag@sub.domain.co.in', 'email')).toBe(true);
  });

  it('rejects what is plainly not an email address', () => {
    expect(check('rahul', 'email')).toBe(false);
    expect(check('rahul@ngo', 'email')).toBe(false);
    expect(check('rahul @ngo.org', 'email')).toBe(false);
  });

  it('accepts a web address with or without the scheme', () => {
    expect(check('https://ngo.org', 'url')).toBe(true);
    expect(check('ngo.org/report', 'url')).toBe(true);
    expect(check('not a url', 'url')).toBe(false);
  });

  it('knows the Indian ID formats', () => {
    expect(check('ABCDE1234F', 'pan')).toBe(true);
    expect(check('ABCD1234F', 'pan')).toBe(false);

    expect(check('1234 5678 9012', 'aadhaar')).toBe(true);
    expect(check('123456789012', 'aadhaar')).toBe(false);

    expect(check('560001', 'pincode')).toBe(true);
    expect(check('56001', 'pincode')).toBe(false);

    expect(check('HDFC0001234', 'ifsc')).toBe(true);
    expect(check('HDFC1001234', 'ifsc')).toBe(false);
  });

  it('lets anything through when no format is set', () => {
    expect(check('literally anything', 'any')).toBe(true);
  });

  it('accepts anything while a custom pattern is still being written', () => {
    // Otherwise every answer is rejected the moment an admin picks "a pattern
    // I set" and before they have typed one.
    expect(checkTextFormat('anything', 'pattern').ok).toBe(true);
    expect(checkTextFormat('anything', 'pattern', '   ').ok).toBe(true);
    expect(checkTextFormat('anything', 'pattern', '^[A-Z]$').ok).toBe(true);
  });

  it('enforces a custom pattern once it is valid', () => {
    expect(checkTextFormat('AB12/3456', 'pattern', 'AA99/9999').ok).toBe(true);
    expect(checkTextFormat('AB123456', 'pattern', 'AA99/9999').ok).toBe(false);
  });

  it('offers an example for every format', () => {
    expect(formatExample('email')).toBe('rahul@ngo.org');
    expect(formatExample('pan')).toBe('ABCDE1234F');
    expect(formatExample('pattern', 'AA99')).toBe('AA99');
    expect(formatExample('any')).toBe('');
  });
});

describe('a question with a format', () => {
  const emailField = (isRequired: boolean) =>
    version(1, [
      field('contact', 'short_text', { isRequired, config: { format: 'email' } }),
    ]);

  it('refuses a badly formatted answer and names the question', () => {
    const result = validateSubmission(emailField(true), { contact: 'not-an-email' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.fieldKey).toBe('contact');
      expect(result.errors[0]?.message).toBe('invalidEmail');
    }
  });

  it('accepts a well formatted one', () => {
    expect(validateSubmission(emailField(true), { contact: 'rahul@ngo.org' }).ok).toBe(true);
  });

  it('does not report an empty optional answer as badly formatted', () => {
    // "Please enter a valid email" on a question nobody had to answer is a
    // dead end for the worker.
    expect(validateSubmission(emailField(false), {}).ok).toBe(true);
    expect(validateSubmission(emailField(false), { contact: '' }).ok).toBe(true);
  });

  it('still reports a required answer as missing, not as badly formatted', () => {
    const result = validateSubmission(emailField(true), { contact: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.message).not.toBe('invalidEmail');
  });

  it('leaves questions with no format alone', () => {
    const plain = version(1, [field('note', 'short_text', { isRequired: true })]);
    expect(validateSubmission(plain, { note: 'whatever they typed' }).ok).toBe(true);
  });
});
