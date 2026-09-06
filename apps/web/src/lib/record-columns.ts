import type { RecordColumn } from '@sangraha/db';
import {
  getFieldType,
  localise,
  type GeneratedColumn,
  type I18nText,
  type OptionSetDefinition,
} from '@sangraha/form-engine';

/**
 * Deciding what a Records table actually shows.
 *
 * A generated view opens with thirteen fixed columns — six of them bare uuids —
 * before the first thing anybody asked a field worker. On `donor_form` that is
 * thirteen columns of machinery in front of two answers, which is why the
 * screen reads as a database dump rather than as an organisation's records.
 *
 * So columns are sorted into three groups: the few that a person recognises,
 * the answers, and the machinery. Only the first two are rendered by default.
 *
 * Pure, and deliberately kept out of the table component and away from the
 * database, so the rules can be tested on their own.
 */

export type ColumnGroup = 'essential' | 'answer' | 'technical';

/** How a cell should be drawn, decided once here rather than in the table. */
export type CellKind =
  | 'text'
  | 'date'
  | 'datetime'
  | 'boolean'
  | 'status'
  | 'person' // a subject uuid — resolved to a name and linked
  | 'user' // a users.id — resolved to a name
  | 'place' // a locations.id — resolved to a name
  | 'choices'; // text[] of option codes

export interface DisplayColumn {
  /** The view column this reads. */
  name: string;
  label: string;
  group: ColumnGroup;
  kind: CellKind;
  /** Option labels by code, for rendering a multi-choice array. */
  options?: Map<string, string>;
}

export interface ColumnPlan {
  essentials: DisplayColumn[];
  answers: DisplayColumn[];
  technical: DisplayColumn[];
  /** Every uuid column that names a person, so the resolver knows where to look. */
  personColumns: string[];
  userColumns: string[];
  placeColumns: string[];
}

/**
 * The fixed columns worth showing, and what to call them.
 *
 * Everything else the generator emits — ids, `form_version`, `created_at`,
 * `self_reviewed` — is real and occasionally needed, and goes behind the
 * toggle rather than being removed.
 */
const ESSENTIALS: { name: string; label: string; kind: CellKind }[] = [
  { name: 'submitted_at', label: 'When', kind: 'datetime' },
  { name: 'subject_id', label: 'About', kind: 'person' },
  { name: 'submitted_by', label: 'Sent by', kind: 'user' },
  { name: 'status', label: 'Status', kind: 'status' },
];

const USER_COLUMNS = new Set(['submitted_by', 'reviewed_by']);
const PLACE_COLUMNS = new Set(['location_id']);

function kindForPgType(pgType: string): CellKind {
  if (pgType === 'date') return 'date';
  if (pgType.startsWith('timestamp')) return 'datetime';
  if (pgType === 'boolean') return 'boolean';
  /*
   * `text[]`, normalised from `udt_name` by `listRecordColumns`. Postgres
   * reports `data_type` as the bare string `ARRAY` for every array type, so
   * this suffix never matched what the database actually said and every
   * multi-choice answer rendered as raw JSON option codes. `ARRAY` is accepted
   * too, so a caller passing `data_type` straight through still works.
   */
  if (pgType.endsWith('[]') || pgType === 'ARRAY') return 'choices';
  return 'text';
}

/**
 * Sorts a view's columns into what to show and what to hide.
 *
 * `columns` is what the view genuinely has, read from `information_schema`;
 * `described` is what the current form definition says it should have. They can
 * disagree — a retired option drops a one-hot from the description but not from
 * the view until the next `db:views` — so the view is the authority and
 * anything unmatched keeps its raw name and lands in technical. Nothing is ever
 * dropped.
 */
export function planColumns(
  columns: RecordColumn[],
  described: GeneratedColumn[],
  locale: string,
): ColumnPlan {
  const sources = new Map(described.filter((c) => c.source).map((c) => [c.name, c.source!]));

  /*
   * Which column stands for each question.
   *
   * A choice question emits its stable code *and* a readable `_label`; a
   * multi-choice emits an array *and* a one-hot boolean per option. The
   * readable one is what a person wants, and the rest stay available behind the
   * toggle — the pair is intact either way, and the CSV is untouched.
   */
  const shownForField = new Map<string, string>();
  for (const column of columns) {
    const source = sources.get(column.name);
    if (!source) continue;
    if (getFieldType(source.dataType).isAttachment) continue;

    const current = shownForField.get(source.fieldKey);
    if (!current) {
      shownForField.set(source.fieldKey, column.name);
      continue;
    }
    // `_label` wins over the code it labels; nothing else displaces a choice.
    if (source.suffix === '_label') shownForField.set(source.fieldKey, column.name);
  }

  const essentials: DisplayColumn[] = [];
  const answers: DisplayColumn[] = [];
  const technical: DisplayColumn[] = [];
  const personColumns: string[] = [];
  const userColumns: string[] = [];
  const placeColumns: string[] = [];

  for (const column of columns) {
    const source = sources.get(column.name);

    if (source) {
      const isShown = shownForField.get(source.fieldKey) === column.name;
      /*
       * The field's own column, not its companions. A `subject_ref` emits both
       * `donor` (the uuid) and `donor_name` (text, for the CSV) and they share a
       * `dataType` — so keying on that alone marked the name column as a person
       * and fed "Sunita Devi" to a uuid lookup, which is a 500 on the whole
       * page rather than one odd cell.
       */
      const kind: CellKind =
        source.dataType === 'subject_ref' && source.suffix === ''
          ? 'person'
          : kindForPgType(column.pgType);

      if (kind === 'person') personColumns.push(column.name);

      (isShown ? answers : technical).push({
        name: column.name,
        label: isShown
          ? localise(source.label, locale, source.fieldKey)
          : column.name,
        group: isShown ? 'answer' : 'technical',
        kind,
        options: optionMap(source.optionSet, locale),
      });
      continue;
    }

    const essential = ESSENTIALS.find((e) => e.name === column.name);
    if (essential) {
      if (essential.kind === 'person') personColumns.push(column.name);
      if (essential.kind === 'user') userColumns.push(column.name);
      essentials.push({ ...essential, group: 'essential' });
      continue;
    }

    if (USER_COLUMNS.has(column.name)) userColumns.push(column.name);
    if (PLACE_COLUMNS.has(column.name)) placeColumns.push(column.name);

    technical.push({
      name: column.name,
      // Raw, on purpose: somebody who turned these on is reading `form_version`
      // because they want `form_version`, and a prettified guess would be worse.
      label: column.name,
      group: 'technical',
      kind: USER_COLUMNS.has(column.name)
        ? 'user'
        : PLACE_COLUMNS.has(column.name)
          ? 'place'
          : kindForPgType(column.pgType),
    });
  }

  // Essentials read in a fixed order regardless of where they sit in the view.
  essentials.sort(
    (a, b) =>
      ESSENTIALS.findIndex((e) => e.name === a.name) -
      ESSENTIALS.findIndex((e) => e.name === b.name),
  );

  return { essentials, answers, technical, personColumns, userColumns, placeColumns };
}

/**
 * The columns actually rendered.
 *
 * A standalone form has no subject, so *About* would be an empty column on
 * every row — dropped rather than shown blank.
 */
export function visibleColumns(
  plan: ColumnPlan,
  rows: Record<string, unknown>[],
  showTechnical: boolean,
): DisplayColumn[] {
  const essentials = plan.essentials.filter(
    (column) =>
      column.name !== 'subject_id' || rows.some((row) => row[column.name] !== null),
  );

  return showTechnical
    ? [...essentials, ...plan.answers, ...plan.technical]
    : [...essentials, ...plan.answers];
}

/** Every id on this page that needs a name, by kind, de-duplicated. */
export function idsToResolve(
  plan: ColumnPlan,
  rows: Record<string, unknown>[],
): { subjectIds: string[]; userIds: string[]; locationIds: string[] } {
  const gather = (names: string[]): string[] => {
    const found = new Set<string>();
    for (const row of rows) {
      for (const name of names) {
        const value = row[name];
        if (typeof value === 'string' && value !== '') found.add(value);
      }
    }
    return [...found];
  };

  return {
    subjectIds: gather(plan.personColumns),
    userIds: gather(plan.userColumns),
    locationIds: gather(plan.placeColumns),
  };
}

function optionMap(
  optionSet: OptionSetDefinition | null | undefined,
  locale: string,
): Map<string, string> | undefined {
  if (!optionSet?.options.length) return undefined;
  return new Map(
    optionSet.options.map((option) => [option.code, localise(option.label, locale, option.code)]),
  );
}

export type { I18nText };
