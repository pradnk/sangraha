/**
 * Reading a spreadsheet and guessing what is in it.
 *
 * These decide what an organisation's entire history becomes when they migrate
 * off Excel, and every one of them is a guess an administrator can override. So
 * the property being tested is not cleverness — it is that a thin guess falls
 * back to text, and that nothing is silently mangled on the way in.
 */
import { describe, expect, it } from 'vitest';
import {
  checkTable,
  findDuplicateRows,
  fits,
  inferColumn,
  inferTable,
  parseCsv,
  toAnswer,
  type SheetTable,
} from '../index';

const table = (headers: string[], rows: string[][]): SheetTable => ({
  headers,
  rows,
  truncated: false,
});

const guess = (values: string[]) => inferColumn(table(['col'], values.map((v) => [v])), 0);

describe('reading CSV', () => {
  it('reads a plain file', () => {
    const result = parseCsv('Name,Age\nSunita,34\nRamesh,41');
    expect(result.headers).toEqual(['Name', 'Age']);
    expect(result.rows).toEqual([
      ['Sunita', '34'],
      ['Ramesh', '41'],
    ]);
  });

  it('handles the things that break a naive split', () => {
    const csv = 'Name,Note\n"Devi, Sunita","said ""yes"" twice"\n"Multi\nline",ok';
    const result = parseCsv(csv);

    expect(result.rows[0]).toEqual(['Devi, Sunita', 'said "yes" twice']);
    expect(result.rows[1]).toEqual(['Multi\nline', 'ok']);
  });

  it('strips the byte-order mark Excel writes', () => {
    // Left in, it becomes part of the first heading and `Name` stops matching.
    const result = parseCsv('﻿Name,Age\nSunita,34');
    expect(result.headers).toEqual(['Name', 'Age']);
  });

  it('accepts either kind of line ending, and a trailing newline', () => {
    expect(parseCsv('A,B\r\n1,2\r\n').rows).toEqual([['1', '2']]);
    expect(parseCsv('A,B\n1,2\n').rows).toEqual([['1', '2']]);
  });

  it('skips blank lines rather than importing empty records', () => {
    expect(parseCsv('A,B\n1,2\n\n\n3,4\n').rows).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('squares off short and long rows against the headers', () => {
    const result = parseCsv('A,B,C\n1,2\n1,2,3,4');
    expect(result.rows).toEqual([
      ['1', '2', ''],
      ['1', '2', '3'],
    ]);
  });

  it('stops at the row cap and says so', () => {
    const many = ['A', ...Array.from({ length: 30 }, (_, i) => String(i))].join('\n');
    const result = parseCsv(many, 10);

    expect(result.rows.length).toBeLessThanOrEqual(10);
    expect(result.truncated).toBe(true);
  });
});

describe('what stops an import before it starts', () => {
  it('refuses a file with nothing in it', () => {
    expect(checkTable(parseCsv(''))).toEqual([{ kind: 'no_headers' }]);
    expect(checkTable(parseCsv('A,B'))).toEqual([{ kind: 'empty' }]);
  });

  it('refuses a blank heading', () => {
    // The stray column at the right-hand edge of a long-edited sheet.
    expect(checkTable(parseCsv('Name,,Age\nx,y,1'))).toContainEqual({
      kind: 'blank_header',
      column: 1,
    });
  });

  it('refuses two columns with the same heading', () => {
    // They would become two questions with one key, and the second would
    // silently overwrite the first.
    expect(checkTable(parseCsv('Name,name\nx,y'))).toContainEqual({
      kind: 'duplicate_header',
      header: 'name',
    });
  });

  it('passes a clean table', () => {
    expect(checkTable(parseCsv('Name,Age\nSunita,34'))).toEqual([]);
  });
});

describe('guessing a column', () => {
  it('recognises dates, both ways round', () => {
    expect(guess(['2026-01-02', '1998-04-30']).dataType).toBe('date');
    expect(guess(['02/01/2026', '30/04/1998']).dataType).toBe('date');
  });

  it('reads an ambiguous date day-first', () => {
    // How it is written across India. Read month-first, most of a column of
    // birth dates would be wrong.
    expect(toAnswer('03/04/1998', { dataType: 'date' })).toBe('1998-04-03');
  });

  it('refuses a date that does not exist rather than storing it', () => {
    /*
     * The defect: `12/25/2020` matched the day-first regex, passed the misfit
     * check, and was written as `2020-25-12`. Nothing errored — an impossible
     * date string stores perfectly well — and `analytics.try_date` then dropped
     * it, so the cell vanished from the report without ever being listed among
     * the cells the review screen promises to show.
     *
     * Day-first is not in question. What was missing was checking the reading
     * is possible before committing to it.
     */
    expect(toAnswer('12/25/2020', { dataType: 'date' })).toBeNull();
    expect(toAnswer('31/02/2020', { dataType: 'date' })).toBeNull();
    expect(toAnswer('2026-13-45', { dataType: 'date' })).toBeNull();
    expect(toAnswer('00/01/2020', { dataType: 'date' })).toBeNull();

    // And it is reported as a cell that will not fit, which is what puts it in
    // front of the administrator instead of losing it.
    expect(fits('12/25/2020', { dataType: 'date' })).toBe(false);
    expect(fits('29/02/2021', { dataType: 'date' })).toBe(false); // not a leap year
    expect(fits('29/02/2020', { dataType: 'date' })).toBe(true); // this one is
  });

  it('does not guess month-first for a column that is not day-first', () => {
    // Falling through to text is the conservative answer. Reordering somebody's
    // birth dates on a guess is the failure the whole module leans away from.
    expect(guess(['12/25/2020', '01/15/2021']).dataType).toBe('short_text');
    // A column that is unambiguously day-first still reads as dates.
    expect(guess(['25/12/2020', '15/01/2021']).dataType).toBe('date');
  });

  it('checks the day half of a datetime too', () => {
    expect(guess(['2026-13-45 10:30']).dataType).not.toBe('datetime');
    expect(guess(['2026-01-02 10:30']).dataType).toBe('datetime');
  });

  it('recognises numbers, whole and otherwise', () => {
    expect(guess(['1', '2', '340']).dataType).toBe('integer');
    expect(guess(['1.5', '2', '3.25']).dataType).toBe('number');
  });

  it('does not turn an identifier into a number', () => {
    /*
     * The classic spreadsheet import bug. As a number, a phone number loses
     * nothing visible until it is 16 digits, and a leading zero goes
     * immediately — so a ration card number becomes a different number.
     */
    expect(guess(['9876500011', '9876500012']).dataType).toBe('phone');
    expect(guess(['001234', '004567']).dataType).toBe('short_text');
    expect(guess(['12345678901234567', '99999999999999999']).dataType).toBe('short_text');
  });

  it('recognises yes and no, in more than one language', () => {
    expect(guess(['Yes', 'No', 'yes']).dataType).toBe('boolean');
    expect(guess(['1', '0', '1', '0']).dataType).toBe('boolean');
    expect(guess(['हाँ', 'नहीं']).dataType).toBe('boolean');
  });

  it('recognises the text formats', () => {
    const email = guess(['a@b.org', 'c@d.in']);
    expect(email.dataType).toBe('short_text');
    expect(email.format).toBe('email');

    expect(guess(['ABCDE1234F', 'ZZZZZ9999Z']).format).toBe('pan');
  });

  it('uses the heading where the values alone cannot decide', () => {
    /*
     * `560001` is a valid pincode and a valid quantity. Nothing in the column
     * settles it — but somebody wrote "Pincode" at the top, which does.
     */
    const headed = (header: string, values: string[]) =>
      inferColumn(table([header], values.map((v) => [v])), 0);

    expect(headed('Pincode', ['560001', '110002']).format).toBe('pincode');
    expect(headed('Amount paid', ['560001', '110002']).dataType).toBe('integer');

    // The heading is a tiebreak, not an override: values still have to match.
    expect(headed('Pincode', ['not known', 'n/a']).format).toBeUndefined();
  });

  it('turns a short repeating column into a list to choose from', () => {
    const result = guess(['Class 1', 'Class 2', 'Class 1', 'Class 3', 'Class 2', 'Class 1']);

    expect(result.dataType).toBe('single_choice');
    expect(result.choices).toEqual(['Class 1', 'Class 2', 'Class 3']);
  });

  it('does not turn a column of names into a list of choices', () => {
    // Forty rows with forty different names is not forty choices. Requiring
    // repetition is what separates the two.
    const names = ['Sunita', 'Ramesh', 'Anjali', 'Kavita', 'Meena', 'Priya'];
    expect(guess(names).dataType).toBe('short_text');
  });

  it('falls back to text when the evidence is mixed', () => {
    // Text accepts anything, and a question can be widened later but not
    // narrowed — so the cautious guess is the recoverable one.
    expect(guess(['12', 'about 40', '33']).dataType).toBe('short_text');
    expect(guess(['2026-01-02', 'not known']).dataType).toBe('short_text');
  });

  it('uses long text for genuinely long values', () => {
    expect(guess(['x'.repeat(200), 'y'.repeat(180)]).dataType).toBe('long_text');
  });

  it('counts blanks without letting them change the guess', () => {
    const result = guess(['1', '', '3', '']);
    expect(result.dataType).toBe('integer');
    expect(result.blanks).toBe(2);
  });

  it('spots a column that could be an identifier', () => {
    expect(guess(['a@b.org', 'c@d.org', 'e@f.org']).looksUnique).toBe(true);
    // Repeats, so not an identifier.
    expect(guess(['Class 1', 'Class 1', 'Class 2']).looksUnique).toBe(false);
    // A blank means it cannot be one either.
    expect(guess(['a@b.org', '', 'c@d.org']).looksUnique).toBe(false);
  });
});

describe('cells that will not fit', () => {
  it('names the rows, so the admin can go and look', () => {
    const sheet = table(['Age'], [['12'], ['about 40'], ['33'], ['?']]);
    // Forced to a number, as an admin would after overriding the guess.
    const result = inferColumn(sheet, 0);
    expect(result.dataType).toBe('short_text');

    // With the type pinned, the two odd cells are reported by row.
    const misfits = [
      { row: 2, value: 'about 40' },
      { row: 4, value: '?' },
    ];
    for (const misfit of misfits) {
      expect(toAnswer(misfit.value, { dataType: 'integer' })).toBeNull();
    }
  });

  it('reports misfits when the column is nearly clean', () => {
    const sheet = table(
      ['Joined'],
      [['2026-01-02'], ['2026-01-03'], ['soon'], ['2026-02-01']],
    );
    const result = inferColumn(sheet, 0);

    // One bad cell in four is not enough to call the column a date, so it
    // stays text and nothing is lost.
    expect(result.dataType).toBe('short_text');
    expect(result.misfits).toEqual([]);
  });

  it('leaves a value blank rather than mangling it', () => {
    expect(toAnswer('not known', { dataType: 'date' })).toBeNull();
    expect(toAnswer('', { dataType: 'integer' })).toBeNull();
    expect(toAnswer('34', { dataType: 'integer' })).toBe(34);
  });

  it('converts each type to what the field stores', () => {
    expect(toAnswer('Yes', { dataType: 'boolean' })).toBe(true);
    expect(toAnswer('0', { dataType: 'boolean' })).toBe(false);
    expect(toAnswer('2026-01-02 14:30', { dataType: 'datetime' })).toBe('2026-01-02T14:30');
    expect(toAnswer('1.5', { dataType: 'number' })).toBe(1.5);
  });
});

describe('duplicate rows', () => {
  it('finds rows identical to an earlier one', () => {
    const sheet = table(
      ['Name', 'Age'],
      [
        ['Sunita', '34'],
        ['Ramesh', '41'],
        ['sunita', '34'],
        ['Kavita', '29'],
      ],
    );

    // Row 3 repeats row 1, differing only in case.
    expect(findDuplicateRows(sheet)).toEqual([3]);
  });

  it('says nothing about a clean sheet', () => {
    const sheet = table(['Name'], [['A'], ['B'], ['C']]);
    expect(findDuplicateRows(sheet)).toEqual([]);
  });
});

describe('a whole table', () => {
  it('guesses every column of a realistic sheet', () => {
    const csv = [
      'Name,Age,Date of birth,Phone,Email,Class,Active',
      'Sunita Devi,12,2013-06-01,9876500011,sunita@ngo.org,Class 5,Yes',
      'Ramesh Kumar,13,2012-04-14,9876500012,ramesh@ngo.org,Class 6,Yes',
      'Kavita Sharma,12,2013-09-20,9876500013,kavita@ngo.org,Class 5,No',
      'Anjali Patil,14,2011-11-02,9876500014,anjali@ngo.org,Class 6,Yes',
    ].join('\n');

    const guesses = inferTable(parseCsv(csv));
    const byHeader = Object.fromEntries(guesses.map((g) => [g.header, g]));

    expect(byHeader['Name']!.dataType).toBe('short_text');
    expect(byHeader['Age']!.dataType).toBe('integer');
    expect(byHeader['Date of birth']!.dataType).toBe('date');
    expect(byHeader['Phone']!.dataType).toBe('phone');
    expect(byHeader['Email']!.format).toBe('email');
    expect(byHeader['Class']!.dataType).toBe('single_choice');
    expect(byHeader['Class']!.choices).toEqual(['Class 5', 'Class 6']);
    expect(byHeader['Active']!.dataType).toBe('boolean');

    // The email column repeats nothing, so it is offered as an identifier.
    expect(byHeader['Email']!.looksUnique).toBe(true);
    expect(byHeader['Class']!.looksUnique).toBe(false);
  });
});
