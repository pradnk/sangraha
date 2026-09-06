/**
 * Records and CSV export, verified against the database.
 *
 * The property that matters most here is that the download matches the screen.
 * An export that quietly applies different filters from the table above it is
 * how a funder report ends up defended with the wrong numbers, and nothing
 * about it looks wrong until somebody checks by hand.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { UTF8_BOM, csvField, csvRow } from '../queries/csv';
import { resolveRecordNames } from '../queries/record-names';
import {
  RECORD_PAGE_SIZES,
  clampPageSize,
  countRecords,
  countRecordsPerForm,
  countRegisteredPeople,
  getRecordView,
  listRecordColumns,
  listRecordViews,
  queryRecords,
  streamRecords,
  type RecordFilters,
  type RecordView,
} from '../queries/records';
import { regenerateFormViews } from '../analytics/generate';
import { subjects, submissions } from '../schema/index';
import {
  closeHarness,
  createTestOrg,
  dropTestOrg,
  hasDatabase,
  ownerDb,
  publishForm,
  type TestOrg,
} from './harness';

describe('csv escaping', () => {
  /*
   * Unit tests, no database — this is the layer where a quiet mistake shifts
   * every column of a row without erroring anywhere.
   */
  it('leaves an ordinary value alone', () => {
    expect(csvField('Sunita')).toBe('Sunita');
    expect(csvField(42)).toBe('42');
  });

  it('quotes a value containing a comma', () => {
    expect(csvField('Devi, Sunita')).toBe('"Devi, Sunita"');
  });

  it('doubles embedded quotes', () => {
    expect(csvField('reason: "fever"')).toBe('"reason: ""fever"""');
  });

  it('quotes a value containing a newline', () => {
    // The one that silently splits a record into two rows.
    expect(csvField('line one\nline two')).toBe('"line one\nline two"');
    expect(csvField('with\r\ncrlf')).toBe('"with\r\ncrlf"');
  });

  it('quotes surrounding whitespace so a reader cannot strip it', () => {
    expect(csvField('  padded  ')).toBe('"  padded  "');
  });

  it('writes an empty field for null and undefined, not the word', () => {
    expect(csvField(null)).toBe('');
    expect(csvField(undefined)).toBe('');
  });

  it('renders a jsonb column as JSON rather than [object Object]', () => {
    expect(csvField({ a: 1 })).toBe('"{""a"":1}"');
  });

  it('stops a cell being run as a formula when the file is opened', () => {
    /*
     * The path this closes: a worker types `=HYPERLINK(...)` or a DDE payload
     * into a free-text question on a phone, an administrator downloads the
     * export and double-clicks it, and the spreadsheet evaluates it on their
     * machine. Nothing in between looks wrong, and the person opening the file
     * has no way to see it coming.
     */
    expect(csvField('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)");
    expect(csvField('+1+1')).toBe("'+1+1");
    expect(csvField('@SUM(A1)')).toBe("'@SUM(A1)");
    // The DDE payload, which is where this stops being theoretical. No comma or
    // quote in it, so RFC 4180 has nothing to say and only the apostrophe does.
    expect(csvField('-2+3+cmd|\' /C calc\'!A0')).toBe("'-2+3+cmd|' /C calc'!A0");
    // A leading tab or return, which some readers strip before looking again.
    expect(csvField('\t=SUM(A1)')).toBe("'\t=SUM(A1)");
    expect(csvField('\r=SUM(A1)')).toBe('"\'\r=SUM(A1)"');
  });

  it('does not mangle a number that merely starts with a minus', () => {
    // The reason the guard cannot simply ban a leading `-`: it begins every
    // negative number, and an export full of `'-5` would be worse than useless.
    expect(csvField(-5)).toBe('-5');
    expect(csvField(-12.75)).toBe('-12.75');
    // Including one that arrived as text, as a jsonb answer does.
    expect(csvField('-5')).toBe('-5');
    expect(csvField('-12.75')).toBe('-12.75');
  });

  it('terminates rows with CRLF, as the spec requires', () => {
    expect(csvRow(['a', 'b'])).toBe('a,b\r\n');
  });

  it('ships a byte-order mark that Excel will recognise', () => {
    // Without it, Excel on Windows reads the file in the system codepage and
    // every Hindi and Kannada name becomes mojibake.
    expect(Buffer.from(UTF8_BOM, 'utf8')).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  });
});

describe.skipIf(!hasDatabase)('records', () => {
  let org: TestOrg;
  let view: RecordView;
  let formId: string;

  /** Collects a full export the way the route does. */
  async function exportRows(filters: RecordFilters): Promise<Record<string, unknown>[]> {
    const all: Record<string, unknown>[] = [];
    // Deliberately a tiny batch so the batching loop is actually exercised
    // rather than every row arriving in one pass.
    for await (const batch of streamRecords(ownerDb(), view, filters, 2)) all.push(...batch);
    return all;
  }

  beforeAll(async () => {
    org = await createTestOrg('reporting');

    const published = await publishForm(org, 'visits', [
      { key: 'note', dataType: 'long_text' },
      { key: 'score', dataType: 'integer' },
    ]);
    formId = published.formId;
    const versionId = published.versionId;

    await regenerateFormViews(ownerDb(), formId);

    const rows = [
      { at: '2026-01-10T09:00:00Z', place: org.villageAId, status: 'approved', note: 'first' },
      { at: '2026-02-10T09:00:00Z', place: org.villageAId, status: 'submitted', note: 'second' },
      { at: '2026-03-10T09:00:00Z', place: org.villageBId, status: 'submitted', note: 'third' },
      { at: '2026-04-10T09:00:00Z', place: org.villageBId, status: 'rejected', note: 'fourth' },
      {
        at: '2026-05-10T09:00:00Z',
        place: org.villageAId,
        status: 'approved',
        // Every way a naive writer breaks, in one value.
        note: 'ಬಂದಿಲ್ಲ, ಕಾರಣ: "ಜ್ವರ"\nमनेगे भेटि',
      },
      // A draft, which the view excludes: it is partially filled by definition.
      { at: '2026-06-10T09:00:00Z', place: org.villageAId, status: 'draft', note: 'unfinished' },
    ];

    for (const [index, row] of rows.entries()) {
      await ownerDb()
        .insert(submissions)
        .values({
          orgId: org.id,
          formId,
          formVersionId: versionId,
          locationId: row.place,
          data: { note: row.note, score: index },
          status: row.status as 'draft' | 'submitted' | 'approved' | 'rejected',
          submittedBy: org.workerAId,
          submittedAt: new Date(row.at),
          clientUuid: randomUUID(),
        });
    }

    const resolved = await getRecordView(ownerDb(), org.id, 'visits');
    if (!resolved) throw new Error('view not registered');
    view = resolved;
  });

  afterAll(async () => {
    await dropTestOrg(org);
    await closeHarness();
  });

  it('lists the form among an organisation’s record views', async () => {
    const views = await listRecordViews(ownerDb(), org.id);
    expect(views.map((v) => v.formSlug)).toContain('visits');
  });

  it('refuses a form belonging to another organisation', async () => {
    const other = await createTestOrg('reporting-other');
    try {
      // Past this point the queries read an owner-rights view, so this null is
      // the entire tenant boundary for the Records screen.
      expect(await getRecordView(ownerDb(), other.id, 'visits')).toBeNull();
    } finally {
      await dropTestOrg(other);
    }
  });

  it('takes its columns from the view, including choice labels', async () => {
    const columns = (await listRecordColumns(ownerDb(), view)).map((c) => c.name);
    expect(columns).toContain('submission_id');
    expect(columns).toContain('status');
    expect(columns).toContain('note');
    expect(columns).toContain('score');
  });

  it('flags a record its own submitter approved', async () => {
    // An org admin may approve what they captured, because there may be nobody
    // else. It has to be countable afterwards, or the review step is taken on
    // trust rather than checked.
    const columns = (await listRecordColumns(ownerDb(), view)).map((c) => c.name);
    expect(columns).toContain('self_reviewed');

    const [row] = (await ownerDb().execute(sql`
      SELECT bool_or(self_reviewed) AS any_self
      FROM ${sql.raw(`"${view.schemaName}"."${view.viewName}"`)}
    `)) as unknown as { any_self: boolean | null }[];

    // Nothing in this fixture was reviewed at all, so the flag is off
    // everywhere — the column exists and defaults honestly.
    expect(row?.any_self ?? false).toBe(false);
  });

  it('leaves drafts out of the counts', async () => {
    const counts = await countRecords(ownerDb(), view, {});
    // Five inserted rows are visible; the sixth is a draft.
    expect(counts.total).toBe(5);
    expect(counts.approved).toBe(2);
    expect(counts.awaitingReview).toBe(2);
    expect(counts.rejected).toBe(1);
  });

  describe('filters', () => {
    const cases: { name: string; filters: RecordFilters; expected: number }[] = [
      { name: 'no filter', filters: {}, expected: 5 },
      { name: 'status', filters: { status: 'approved' }, expected: 2 },
      { name: 'from', filters: { from: '2026-03-01' }, expected: 3 },
      { name: 'to', filters: { to: '2026-02-28' }, expected: 2 },
      { name: 'a range', filters: { from: '2026-02-01', to: '2026-03-31' }, expected: 2 },
      { name: 'a range with nothing in it', filters: { from: '2027-01-01' }, expected: 0 },
    ];

    it.each(cases)('narrows correctly: $name', async ({ filters, expected }) => {
      const counts = await countRecords(ownerDb(), view, filters);
      expect(counts.total).toBe(expected);
    });

    it('includes the whole of the last day, not just midnight', async () => {
      // "to 10 February" has to include a visit recorded at 9am on the 10th,
      // which a naive `<= date` comparison drops.
      const counts = await countRecords(ownerDb(), view, {
        from: '2026-02-10',
        to: '2026-02-10',
      });
      expect(counts.total).toBe(1);
    });

    it('treats a place as covering everything beneath it', async () => {
      const village = await countRecords(ownerDb(), view, { locationId: org.villageAId });
      expect(village.total).toBe(3);

      // The district contains both villages, which is what an admin means by
      // filtering to a district.
      const district = await countRecords(ownerDb(), view, { locationId: org.districtId });
      expect(district.total).toBe(5);
    });
  });

  describe('the download matches the screen', () => {
    /*
     * Built as thunks, not literals. `org` does not exist until `beforeAll`
     * runs, and a literal `{ locationId: org.villageBId }` in the `it.each`
     * table would be evaluated at collection time — quietly producing
     * `undefined` and testing the unfiltered path a second time while reading
     * as though it covered place filtering.
     */
    const cases: { name: string; filters: () => RecordFilters }[] = [
      { name: 'unfiltered', filters: () => ({}) },
      { name: 'by status', filters: () => ({ status: 'approved' }) },
      { name: 'by date range', filters: () => ({ from: '2026-02-01', to: '2026-04-30' }) },
      { name: 'by place', filters: () => ({ locationId: org.villageBId }) },
    ];

    it.each(cases)('returns the same rows in the same order: $name', async ({ filters }) => {
      const live = filters();

      const counts = await countRecords(ownerDb(), view, live);
      const page = await queryRecords(ownerDb(), view, live, 1, counts.total);
      const exported = await exportRows(live);

      // A filter that matches everything would make this pass without testing
      // anything, so each case must actually narrow or be the stated total.
      expect(counts.total).toBeGreaterThan(0);
      expect(exported).toHaveLength(counts.total);
      expect(exported.map((r) => r.submission_id)).toEqual(page.rows.map((r) => r.submission_id));
    });

    it('narrows to fewer rows than unfiltered, so the cases above mean something', async () => {
      const all = await countRecords(ownerDb(), view, {});
      const byPlace = await countRecords(ownerDb(), view, { locationId: org.villageBId });
      const byStatus = await countRecords(ownerDb(), view, { status: 'approved' });

      expect(byPlace.total).toBeLessThan(all.total);
      expect(byStatus.total).toBeLessThan(all.total);
    });
  });

  describe('paging', () => {
    it('splits the rows without dropping or repeating any', async () => {
      const counts = await countRecords(ownerDb(), view, {});
      const first = await queryRecords(ownerDb(), view, {}, 1, counts.total);
      const seen = new Set(first.rows.map((r) => r.submission_id));

      for (let page = 2; page <= first.pageCount; page += 1) {
        const next = await queryRecords(ownerDb(), view, {}, page, counts.total);
        for (const row of next.rows) seen.add(row.submission_id);
      }

      expect(seen.size).toBe(counts.total);
    });

    it('honours a chosen page size', async () => {
      const counts = await countRecords(ownerDb(), view, {});
      // Two rows a page over the fixture's five records.
      const page = await queryRecords(ownerDb(), view, {}, 1, counts.total, 50);

      expect(page.pageSize).toBe(50);
      expect(page.rows.length).toBeLessThanOrEqual(50);
      for (const size of RECORD_PAGE_SIZES) {
        const result = await queryRecords(ownerDb(), view, {}, 1, counts.total, size);
        expect(result.pageSize).toBe(size);
        expect(result.rows.length).toBeLessThanOrEqual(size);
      }
    });

    it('clamps a page size nobody offered', async () => {
      /*
       * A hand-edited `?per=1000000` must not be a resource question that
       * depends on the URL parser having sanitised it first.
       */
      expect(clampPageSize(1_000_000)).toBe(50);
      expect(clampPageSize(0)).toBe(50);
      expect(clampPageSize(-1)).toBe(50);
      expect(clampPageSize('lots')).toBe(50);
      expect(clampPageSize(undefined)).toBe(50);
      expect(clampPageSize(250)).toBe(250);

      const counts = await countRecords(ownerDb(), view, {});
      const page = await queryRecords(ownerDb(), view, {}, 1, counts.total, 1_000_000);
      expect(page.pageSize).toBe(50);
    });

    it('keeps the five-argument callers meaning what they meant', async () => {
      // The signature grew a sixth parameter; the old calls must not change.
      const counts = await countRecords(ownerDb(), view, {});
      const page = await queryRecords(ownerDb(), view, {}, 1, counts.total);
      expect(page.pageSize).toBe(50);
    });

    it('clamps a page number past the end rather than showing nothing', async () => {
      const counts = await countRecords(ownerDb(), view, {});
      // An admin who filters while on page 7 would otherwise land on an empty
      // screen that reads exactly like "you have no data".
      const page = await queryRecords(ownerDb(), view, {}, 999, counts.total);
      expect(page.page).toBe(page.pageCount);
      expect(page.rows.length).toBeGreaterThan(0);
    });
  });

  it('produces a file a spreadsheet can read back unchanged', async () => {
    const columns = await listRecordColumns(ownerDb(), view);
    const rows = await exportRows({});

    const csv =
      UTF8_BOM +
      csvRow(columns.map((c) => c.name)) +
      rows.map((row) => csvRow(columns.map((c) => row[c.name]))).join('');

    const parsed = parseCsv(csv.slice(UTF8_BOM.length));
    expect(parsed).toHaveLength(rows.length + 1);

    // Every row still has the full column count — the assertion that catches a
    // stray comma or newline shifting a row's columns along by one.
    for (const row of parsed) expect(row).toHaveLength(columns.length);

    const noteIndex = columns.findIndex((c) => c.name === 'note');
    const awkward = parsed.find((row) => row[noteIndex]?.includes('ಜ್ವರ'));
    expect(awkward?.[noteIndex]).toBe('ಬಂದಿಲ್ಲ, ಕಾರಣ: "ಜ್ವರ"\nमनेगे भेटि');
  });

  it('excludes a form’s draft rows from the export too', async () => {
    const rows = await exportRows({});
    expect(rows.map((r) => r.note)).not.toContain('unfinished');
  });
});

/** A minimal RFC 4180 reader, so the test does not trust the writer's own rules. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\r' && text[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
    } else field += char;
  }

  if (field || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

describe.skipIf(!hasDatabase)('naming the ids in a page of records', () => {
  let org: TestOrg;
  let other: TestOrg;
  let subjectId: string;
  let otherSubjectId: string;

  beforeAll(async () => {
    org = await createTestOrg('names');
    other = await createTestOrg('names-other');

    const mine = await publishForm(org, 'reg', [{ key: 'name', dataType: 'text' }], {
      formType: 'registration',
      displayNameFields: ['name'],
    });
    const [created] = await ownerDb()
      .insert(subjects)
      .values({
        orgId: org.id,
        subjectTypeId: mine.subjectTypeId,
        displayName: 'Sunita Devi',
        attributes: {},
        locationId: org.villageAId,
        createdBy: org.workerAId,
      })
      .returning({ id: subjects.id });
    subjectId = created!.id;

    const theirs = await publishForm(other, 'reg', [{ key: 'name', dataType: 'text' }], {
      formType: 'registration',
      displayNameFields: ['name'],
    });
    const [theirPerson] = await ownerDb()
      .insert(subjects)
      .values({
        orgId: other.id,
        subjectTypeId: theirs.subjectTypeId,
        displayName: 'Somebody Elses Beneficiary',
        attributes: {},
        locationId: other.villageAId,
        createdBy: other.workerAId,
      })
      .returning({ id: subjects.id });
    otherSubjectId = theirPerson!.id;
  });

  afterAll(async () => {
    await dropTestOrg(org);
    await dropTestOrg(other);
    await closeHarness();
  });

  it('names people, workers and places', async () => {
    const names = await resolveRecordNames(ownerDb(), org.id, {
      subjectIds: [subjectId],
      userIds: [org.workerAId],
      locationIds: [org.villageAId],
    });

    expect(names.subject(subjectId)).toEqual({ id: subjectId, displayName: 'Sunita Devi' });
    expect(names.user(org.workerAId)).toBe('Worker A');
    expect(names.location(org.villageAId)).toEqual({ en: 'Village A' });
  });

  it('will not name another organisation’s beneficiary', async () => {
    /*
     * The boundary. The table is read on the owner connection, where RLS does
     * not apply, and a stale uuid in a jsonb answer is just data — so without
     * the org filter this would happily print a stranger's name into an
     * unrelated NGO's records screen.
     */
    const names = await resolveRecordNames(ownerDb(), org.id, {
      subjectIds: [otherSubjectId],
      userIds: [other.workerAId],
      locationIds: [other.villageAId],
    });

    expect(names.subject(otherSubjectId)).toBeNull();
    expect(names.user(other.workerAId)).toBeNull();
    expect(names.location(other.villageAId)).toBeNull();

    // Not merely absent from the result — nowhere in it.
    expect(JSON.stringify(names.subject(otherSubjectId))).not.toContain('Beneficiary');
  });

  it('returns nothing for an id that does not exist, rather than the id itself', async () => {
    const names = await resolveRecordNames(ownerDb(), org.id, {
      subjectIds: [randomUUID()],
      userIds: [],
      locationIds: [],
    });

    // A uuid dressed up as a name is worse than a blank cell.
    expect(names.subject(randomUUID())).toBeNull();
    expect(names.user(null)).toBeNull();
    expect(names.location(undefined)).toBeNull();
  });

  it('asks the database nothing when there is nothing to ask', async () => {
    const names = await resolveRecordNames(ownerDb(), org.id, {
      subjectIds: [],
      userIds: [],
      locationIds: [],
    });
    expect(names.subject(subjectId)).toBeNull();
  });

  it('resolves a large page in a bounded number of round trips', async () => {
    /*
     * The N+1 this exists to avoid: one query per row would be 500 round trips
     * for a full page. Counted rather than asserted by timing.
     */
    let queries = 0;
    const counting = new Proxy(ownerDb(), {
      get(target, prop, receiver) {
        if (prop === 'select') queries += 1;
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }) as unknown as typeof ownerDb extends () => infer T ? T : never;

    const manyIds = Array.from({ length: 300 }, () => subjectId);
    await resolveRecordNames(counting, org.id, {
      subjectIds: manyIds,
      userIds: Array.from({ length: 300 }, () => org.workerAId),
      locationIds: [],
    });

    // Three columns of ids, at most one query each — and none for the empty one.
    expect(queries).toBeLessThanOrEqual(3);
  });
});

describe.skipIf(!hasDatabase)('the download is not what the screen is showing', () => {
  /*
   * The regression the redesign invites. `queryRecords` gained a page size and
   * the export route shares `filtersFromParams` with the screen — so one stray
   * `{ ...pagination }` in the filters and the CSV becomes one screenful. The
   * file opens fine, has the right columns, and is missing most of the data,
   * which is the worst shape a bug can take in a funder report.
   *
   * A separate organisation because the assertion needs more records than the
   * smallest page holds, and the fixture above deliberately has five.
   */
  const RECORDS = 63;

  let org: TestOrg;
  let view: RecordView;

  beforeAll(async () => {
    org = await createTestOrg('export-paging');

    const published = await publishForm(org, 'visits', [{ key: 'note', dataType: 'short_text' }]);
    await regenerateFormViews(ownerDb(), published.formId);

    await ownerDb()
      .insert(submissions)
      .values(
        Array.from({ length: RECORDS }, (_, index) => ({
          orgId: org.id,
          formId: published.formId,
          formVersionId: published.versionId,
          locationId: org.villageAId,
          data: { note: `visit ${index}` },
          status: 'approved' as const,
          submittedBy: org.workerAId,
          // Distinct timestamps, so paging has a total order to work with and
          // "nothing dropped, nothing repeated" is a real assertion.
          submittedAt: new Date(Date.UTC(2026, 0, 1) + index * 86_400_000),
          clientUuid: randomUUID(),
        })),
      );

    const resolved = await getRecordView(ownerDb(), org.id, 'visits');
    if (!resolved) throw new Error('view not registered');
    view = resolved;
  });

  afterAll(async () => {
    await dropTestOrg(org);
    await closeHarness();
  });

  it('exports every row while the screen is showing fifty', async () => {
    const filters: RecordFilters = {};

    const screen = await queryRecords(ownerDb(), view, filters, 1, RECORDS, 50);
    expect(screen.rows).toHaveLength(50);

    // The same filters the route passes, taken no further.
    const exported: Record<string, unknown>[] = [];
    for await (const batch of streamRecords(ownerDb(), view, filters)) exported.push(...batch);

    expect(exported).toHaveLength(RECORDS);
  });

  it('exports every row at every page size the screen offers', async () => {
    const exported: Record<string, unknown>[] = [];
    for await (const batch of streamRecords(ownerDb(), view, {})) exported.push(...batch);

    for (const size of RECORD_PAGE_SIZES) {
      const screen = await queryRecords(ownerDb(), view, {}, 1, RECORDS, size);
      expect(screen.rows.length).toBe(Math.min(size, RECORDS));
      // Whatever the screen is doing, the file is the whole thing.
      expect(exported).toHaveLength(RECORDS);
    }
  });

  it('still narrows the export when the filters narrow', async () => {
    /*
     * The other half of the property, and the reason this cannot be fixed by
     * simply ignoring the query string: the download must still match the
     * screen's *filters*. Only the paging is dropped.
     */
    const filters: RecordFilters = { from: '2026-02-01' };

    const exported: Record<string, unknown>[] = [];
    for await (const batch of streamRecords(ownerDb(), view, filters)) exported.push(...batch);

    const counts = await countRecords(ownerDb(), view, filters);
    expect(exported).toHaveLength(counts.total);
    expect(counts.total).toBeGreaterThan(0);
    expect(counts.total).toBeLessThan(RECORDS);
  });

  it('walks the pages without dropping or repeating a record', async () => {
    for (const size of [50, 100]) {
      const seen: string[] = [];
      const first = await queryRecords(ownerDb(), view, {}, 1, RECORDS, size);

      for (let page = 1; page <= first.pageCount; page += 1) {
        const result = await queryRecords(ownerDb(), view, {}, page, RECORDS, size);
        seen.push(...result.rows.map((row) => String(row.submission_id)));
      }

      expect(seen).toHaveLength(RECORDS);
      expect(new Set(seen).size).toBe(RECORDS);
    }
  });
});

describe.skipIf(!hasDatabase)('the Records index', () => {
  let org: TestOrg;
  let visitsId: string;
  let emptyId: string;

  beforeAll(async () => {
    org = await createTestOrg('index');

    const visits = await publishForm(org, 'visits', [{ key: 'note', dataType: 'short_text' }]);
    visitsId = visits.formId;
    await regenerateFormViews(ownerDb(), visitsId);

    // A published form nobody has used yet — the case the old grid rendered
    // identically to one holding four hundred records.
    const empty = await publishForm(org, 'unused', [{ key: 'note', dataType: 'short_text' }]);
    emptyId = empty.formId;
    await regenerateFormViews(ownerDb(), emptyId);

    await ownerDb()
      .insert(submissions)
      .values(
        (
          [
            ['approved', '2026-01-05T09:00:00Z'],
            ['approved', '2026-01-06T09:00:00Z'],
            ['submitted', '2026-03-07T09:00:00Z'],
            // Excluded, like the views exclude it: a half-filled form on
            // somebody's phone is not a record.
            ['draft', '2026-09-09T09:00:00Z'],
          ] as const
        ).map(([status, at]) => ({
          orgId: org.id,
          formId: visitsId,
          formVersionId: visits.versionId,
          locationId: org.villageAId,
          data: { note: status },
          status,
          submittedBy: org.workerAId,
          submittedAt: new Date(at),
          clientUuid: randomUUID(),
        })),
      );
  });

  afterAll(async () => {
    await dropTestOrg(org);
    await closeHarness();
  });

  it('agrees with the number on the form’s own screen', async () => {
    /*
     * Two different queries over two different relations — one aggregate on
     * `submissions`, one on the generated view. The index disagreeing with the
     * screen it links to is the failure that makes an admin stop trusting both.
     */
    const counts = await countRecordsPerForm(ownerDb(), org.id);
    const view = await getRecordView(ownerDb(), org.id, 'visits');
    const onScreen = await countRecords(ownerDb(), view!, {});

    expect(counts.get(visitsId)?.total).toBe(onScreen.total);
    expect(counts.get(visitsId)?.awaitingReview).toBe(onScreen.awaitingReview);
    expect(onScreen.total).toBe(3);
  });

  it('reports the most recent record, ignoring the draft', async () => {
    const counts = await countRecordsPerForm(ownerDb(), org.id);
    // The draft is dated September and must not be what "last added" shows.
    expect(counts.get(visitsId)?.lastRecordAt?.toISOString()).toBe('2026-03-07T09:00:00.000Z');
  });

  it('says nothing at all about a form with no records', async () => {
    // Absent rather than zero: the page renders "No records yet" from this.
    const counts = await countRecordsPerForm(ownerDb(), org.id);
    expect(counts.has(emptyId)).toBe(false);
  });

  it('counts one organisation and not the next', async () => {
    const other = await createTestOrg('index-other');
    try {
      expect((await countRecordsPerForm(ownerDb(), other.id)).size).toBe(0);
      expect(await countRegisteredPeople(ownerDb(), other.id)).toBe(0);
    } finally {
      await dropTestOrg(other);
    }
  });

  it('finds a form whose view could not be named after its slug', async () => {
    /*
     * `subjects` is a reserved view name, so this form's view is
     * `subjects_form`. Both queries used to match `view_name = forms.slug`, so
     * the form would have been missing from Records and 404ed on its own URL,
     * with nothing on either screen to explain why. No organisation has one
     * today; this is what stops the first one finding out the hard way.
     */
    const reserved = await publishForm(org, 'subjects', [
      { key: 'note', dataType: 'short_text' },
    ]);
    await regenerateFormViews(ownerDb(), reserved.formId);

    const listed = await listRecordViews(ownerDb(), org.id);
    const found = listed.find((v) => v.formSlug === 'subjects');
    expect(found?.viewName).toBe('subjects_form');

    const resolved = await getRecordView(ownerDb(), org.id, 'subjects');
    expect(resolved?.viewName).toBe('subjects_form');

    // And the view it resolved to is genuinely readable — not a name that
    // happens to match nothing.
    expect(await countRecords(ownerDb(), resolved!, {})).toMatchObject({ total: 0 });
  });

  it('still lists a form once, not once per view it owns', async () => {
    // A registration form registers its own view and a subject dimension view,
    // both with a null repeat-group key. Only the first is a form's records.
    const registration = await publishForm(org, 'intake', [{ key: 'name', dataType: 'short_text' }], {
      formType: 'registration',
      displayNameFields: ['name'],
    });
    await regenerateFormViews(ownerDb(), registration.formId);

    const listed = await listRecordViews(ownerDb(), org.id);
    const intake = listed.filter((v) => v.formSlug === 'intake');

    expect(intake).toHaveLength(1);
    // Its own view, not the `subjects_<code>` dimension recorded against it.
    expect(intake[0]!.viewName).toBe('intake');
  });
});

describe.skipIf(!hasDatabase)('a “link to a person” column in the view', () => {
  /*
   * The CSV half of the change. The screen resolves these ids in JavaScript;
   * the export cannot, so the view carries the name itself.
   */
  let org: TestOrg;
  let other: TestOrg;
  let view: RecordView;
  let sunitaId: string;
  let strangerId: string;

  async function nameColumn(donorId: string | null): Promise<string | null> {
    const [row] = (await ownerDb().execute(sql`
      SELECT donor_name
      FROM ${sql.raw(`"${view.schemaName}"."${view.viewName}"`)}
      WHERE donor IS NOT DISTINCT FROM ${donorId}::uuid
      LIMIT 1
    `)) as unknown as { donor_name: string | null }[];

    return row?.donor_name ?? null;
  }

  beforeAll(async () => {
    org = await createTestOrg('refname');
    other = await createTestOrg('refname-other');

    const registration = await publishForm(org, 'people', [{ key: 'name', dataType: 'short_text' }], {
      formType: 'registration',
      displayNameFields: ['name'],
    });

    const insertSubject = async (into: TestOrg, subjectTypeId: string, displayName: string) => {
      const [created] = await ownerDb()
        .insert(subjects)
        .values({
          orgId: into.id,
          subjectTypeId,
          displayName,
          attributes: {},
          locationId: into.villageAId,
          createdBy: into.workerAId,
        })
        .returning({ id: subjects.id });
      return created!.id;
    };

    sunitaId = await insertSubject(org, registration.subjectTypeId, 'Sunita Devi');

    const theirs = await publishForm(other, 'people', [{ key: 'name', dataType: 'short_text' }], {
      formType: 'registration',
      displayNameFields: ['name'],
    });
    strangerId = await insertSubject(other, theirs.subjectTypeId, 'Someone Else');

    const donations = await publishForm(org, 'donations', [
      { key: 'donor', dataType: 'subject_ref' },
    ]);
    await regenerateFormViews(ownerDb(), donations.formId);

    const rows = [
      sunitaId,
      // Points at nobody at all.
      '00000000-0000-4000-8000-000000000000',
      // Points at a real person in a different organisation.
      strangerId,
      null,
    ];

    for (const donor of rows) {
      await ownerDb()
        .insert(submissions)
        .values({
          orgId: org.id,
          formId: donations.formId,
          formVersionId: donations.versionId,
          locationId: org.villageAId,
          data: donor ? { donor } : {},
          status: 'approved',
          submittedBy: org.workerAId,
          clientUuid: randomUUID(),
        });
    }

    const resolved = await getRecordView(ownerDb(), org.id, 'donations');
    if (!resolved) throw new Error('view not registered');
    view = resolved;
  });

  afterAll(async () => {
    await dropTestOrg(org);
    await dropTestOrg(other);
    await closeHarness();
  });

  it('carries the name beside the id', async () => {
    const columns = (await listRecordColumns(ownerDb(), view)).map((c) => c.name);

    // Both: the uuid still joins, the name still reads.
    expect(columns).toContain('donor');
    expect(columns).toContain('donor_name');

    expect(await nameColumn(sunitaId)).toBe('Sunita Devi');
  });

  it('will not name another organisation’s person', async () => {
    /*
     * The tenant boundary, and the reason the subquery filters on `org_id`.
     * These views run with owner rights, so without it a stray uuid in a jsonb
     * answer prints somebody else's beneficiary into this organisation's CSV.
     */
    expect(await nameColumn(strangerId)).toBeNull();

    // And the row is genuinely there — this is a null name, not a missing row.
    const [row] = (await ownerDb().execute(sql`
      SELECT count(*)::int AS n
      FROM ${sql.raw(`"${view.schemaName}"."${view.viewName}"`)}
      WHERE donor = ${strangerId}::uuid
    `)) as unknown as { n: number }[];
    expect(row?.n).toBe(1);
  });

  it('is null, not an error, when the id names nobody', async () => {
    expect(await nameColumn('00000000-0000-4000-8000-000000000000')).toBeNull();
    expect(await nameColumn(null)).toBeNull();
  });

  it('reads the name as it is now', async () => {
    // Unlike a choice label, which is frozen into the view as a CASE until the
    // form is republished. Worth knowing: the two columns behave differently
    // after a rename, and this is what says so.
    await ownerDb()
      .update(subjects)
      .set({ displayName: 'Sunita Devi (married name)' })
      .where(eq(subjects.id, sunitaId));

    expect(await nameColumn(sunitaId)).toBe('Sunita Devi (married name)');
  });

  it('builds every view a registration form owns, not just its own', async () => {
    /*
     * A registration form also generates the `subjects_<type>` dimension, and
     * that one is `FROM public.subjects subj` — no `s` in scope at all. The
     * first version of this column hardcoded `s.org_id`, so any organisation
     * with a "link to a person" question on a registration form failed to
     * regenerate with `missing FROM-clause entry for table "s"`, taking every
     * other view in the run down with it.
     */
    const registration = await publishForm(
      org,
      'households',
      [
        { key: 'name', dataType: 'short_text' },
        { key: 'head', dataType: 'subject_ref' },
      ],
      { formType: 'registration', displayNameFields: ['name'] },
    );

    const result = await regenerateFormViews(ownerDb(), registration.formId);
    expect(result.created).toEqual(expect.arrayContaining(['households']));

    // And the dimension view genuinely has the column and is readable.
    const [row] = (await ownerDb().execute(sql`
      SELECT count(*)::int AS n
      FROM information_schema.columns
      WHERE table_schema = ${view.schemaName}
        AND table_name = ${result.created.find((n) => n.startsWith('subjects_'))}
        AND column_name = 'head_name'
    `)) as unknown as { n: number }[];
    expect(row?.n).toBe(1);
  });

  it('survives an answer that is not a uuid at all', async () => {
    /*
     * A bulk import can land anything in a jsonb answer. A bare `::uuid` would
     * abort the whole view — every column, every row — so the cast has to be
     * `analytics.try_uuid`.
     */
    const junk = await publishForm(org, 'junk', [{ key: 'donor', dataType: 'subject_ref' }]);
    await regenerateFormViews(ownerDb(), junk.formId);

    await ownerDb()
      .insert(submissions)
      .values({
        orgId: org.id,
        formId: junk.formId,
        formVersionId: junk.versionId,
        locationId: org.villageAId,
        data: { donor: 'not a uuid' },
        status: 'approved',
        submittedBy: org.workerAId,
        clientUuid: randomUUID(),
      });

    const junkView = await getRecordView(ownerDb(), org.id, 'junk');
    const rows = (await ownerDb().execute(sql`
      SELECT donor, donor_name
      FROM ${sql.raw(`"${junkView!.schemaName}"."${junkView!.viewName}"`)}
    `)) as unknown as { donor: string | null; donor_name: string | null }[];

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ donor: null, donor_name: null });
  });
});

describe.skipIf(!hasDatabase)('ids that are not ids', () => {
  let org: TestOrg;

  beforeAll(async () => {
    org = await createTestOrg('badids');
  });

  afterAll(async () => {
    await dropTestOrg(org);
    await closeHarness();
  });

  it('ignores a value that is not a uuid instead of failing the page', async () => {
    /*
     * These ids come out of jsonb answers, where a bulk import can put
     * anything. Reaching Postgres, a non-uuid raises `invalid input syntax for
     * type uuid` — which is not one bad cell, it is a 500 on the whole Records
     * screen. This shipped once: a `subject_ref`'s companion `_name` column was
     * classified as a person, so a page of names was sent to this resolver.
     */
    const names = await resolveRecordNames(ownerDb(), org.id, {
      subjectIds: ['Sunita Devi', '', 'not-a-uuid'],
      userIds: ['also not a uuid'],
      locationIds: ['{"json": true}'],
    });

    expect(names.subject('Sunita Devi')).toBeNull();
    expect(names.user('also not a uuid')).toBeNull();
    expect(names.location('{"json": true}')).toBeNull();
  });
});
