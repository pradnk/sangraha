'use client';

import { useMemo, useState } from 'react';
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import {
  formatValue,
  getFieldType,
  resolveFieldConfig,
  validateSubmission,
  visibleFields,
  type FieldDefinition,
} from '@sangraha/form-engine';
import { t } from '@/lib/i18n';
import { isMessageKey, m } from '@/lib/messages';
import { QuestionInput, type QuestionInputProps } from './question-input';

/**
 * A repeating section — "add another household member", "add another crop".
 *
 * Two screens. The outer one is a list of what has been added, which is the
 * thing a worker needs to see: how many, and who. The inner one edits a single
 * entry.
 *
 * The inner screen stacks its questions rather than showing one at a time, and
 * that is a deliberate departure from the rest of the capture UI. An entry is a
 * tight cluster of facts about one thing — a name, an age, a relationship — and
 * the worker has to see them together to be sure they describe the same person.
 * Paging through them one at a time would also turn "add six family members"
 * into thirty screens, which is how a form stops being filled in honestly.
 *
 * Entries are only committed to the answer on Done. A half-typed person who the
 * worker backs out of should leave nothing behind.
 */

type EntryData = Record<string, unknown>;

export function RepeatGroupAnswer({
  field,
  config,
  value,
  locale,
  version,
  onChange,
}: QuestionInputProps) {
  const entries = useMemo<EntryData[]>(() => (Array.isArray(value) ? (value as EntryData[]) : []), [value]);

  const children = useMemo(
    () =>
      (version?.fields ?? [])
        .filter((f) => f.parentGroupId === field.id)
        .sort((a, b) => a.sortOrder - b.sortOrder),
    [version, field.id],
  );

  const maxEntries = Number(config.maxEntries ?? 50);
  const minEntries = Number(config.minEntries ?? 0);
  const summaryKeys = Array.isArray(config.summaryFieldKeys)
    ? (config.summaryFieldKeys as string[])
    : [];
  const addLabel =
    t(config.addLabel as Record<string, string> | undefined, locale, '') || m(locale, 'repeatAdd');

  /** Which entry is open: an index, or -1 for one being added. */
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState<EntryData>({});

  if (!version || children.length === 0) {
    // A group with no questions in it cannot be filled in. Says so rather than
    // showing an Add button that opens an empty screen. The same branch covers
    // a caller that passed no form version, since without one there is nothing
    // to look the child questions up in.
    return (
      <p className="rounded-field bg-amber-50 p-4 text-field-sm text-amber-900">
        {m(locale, 'repeatNoQuestions')}
      </p>
    );
  }

  if (editing !== null) {
    return (
      <EntryEditor
        fields={children}
        version={version}
        draft={draft}
        locale={locale}
        onDraftChange={setDraft}
        onCancel={() => setEditing(null)}
        onDone={(entry) => {
          const next = [...entries];
          if (editing === -1) next.push(entry);
          else next[editing] = entry;
          onChange(next);
          setEditing(null);
        }}
      />
    );
  }

  const atCapacity = entries.length >= maxEntries;

  return (
    <div className="flex flex-col gap-3">
      {entries.length === 0 ? (
        <p className="rounded-field bg-slate-50 p-4 text-field-sm text-slate-500">
          {minEntries > 0
            ? m(locale, 'repeatNeedMore', { count: minEntries })
            : m(locale, 'repeatEmpty')}
        </p>
      ) : (
        <ol className="flex flex-col gap-2">
          {entries.map((entry, index) => (
            <li
              key={index}
              className="flex items-center gap-2 rounded-field border-2 border-slate-200 bg-white p-3"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-field-sm text-slate-500">
                  {m(locale, 'repeatEntry', { number: index + 1 })}
                </span>
                <span className="block truncate text-field-base text-slate-900">
                  {summarise(entry, children, summaryKeys, locale) ||
                    m(locale, 'repeatEntry', { number: index + 1 })}
                </span>
              </span>

              <button
                type="button"
                onClick={() => {
                  setDraft(entry);
                  setEditing(index);
                }}
                aria-label={m(locale, 'repeatEdit')}
                className="flex min-h-tap min-w-tap shrink-0 items-center justify-center rounded-field border-2 border-slate-300 text-slate-700"
              >
                <Pencil aria-hidden className="h-5 w-5" />
              </button>
              <button
                type="button"
                onClick={() => onChange(entries.filter((_, i) => i !== index))}
                aria-label={m(locale, 'remove')}
                className="flex min-h-tap min-w-tap shrink-0 items-center justify-center rounded-field border-2 border-deny-300 text-deny-700"
              >
                <Trash2 aria-hidden className="h-5 w-5" />
              </button>
            </li>
          ))}
        </ol>
      )}

      <button
        type="button"
        disabled={atCapacity}
        onClick={() => {
          setDraft({});
          setEditing(-1);
        }}
        className="field-button border-2 border-brand-500 bg-white text-brand-700 disabled:opacity-50"
      >
        <Plus aria-hidden className="h-5 w-5" />
        {addLabel}
      </button>

      {atCapacity ? (
        <p className="text-field-sm text-slate-500">{m(locale, 'repeatFull', { count: maxEntries })}</p>
      ) : null}
    </div>
  );
}

/**
 * Builds the one-line title for a saved entry.
 *
 * `summaryFieldKeys` is what the admin chose to identify an entry by, and it is
 * the difference between a list reading "1, 2, 3" and "Ramesh, 12". Falls back
 * to the first answered question, because an unconfigured group should still
 * produce a usable list rather than a column of numbers.
 */
function summarise(
  entry: EntryData,
  children: FieldDefinition[],
  summaryKeys: string[],
  locale: string,
): string {
  const keys = summaryKeys.length > 0 ? summaryKeys : children.slice(0, 1).map((c) => c.key);

  return keys
    .map((key) => {
      const child = children.find((c) => c.key === key);
      if (!child) return '';
      return formatValue(child, entry[key], locale);
    })
    .filter((part) => part !== '')
    .join(', ');
}

function EntryEditor({
  fields,
  version,
  draft,
  locale,
  onDraftChange,
  onCancel,
  onDone,
}: {
  fields: FieldDefinition[];
  version: NonNullable<QuestionInputProps['version']>;
  draft: EntryData;
  locale: string;
  onDraftChange: (next: EntryData) => void;
  onCancel: () => void;
  onDone: (entry: EntryData) => void;
}) {
  const [error, setError] = useState<string | null>(null);

  // Skip logic works inside an entry exactly as it does outside one, and is
  // scoped to the entry: "if this member is a child, ask which school" reads
  // the answers of the member being edited, not of the form around it.
  const questions = visibleFields(fields, draft);

  const submit = () => {
    /*
     * Validated with the children promoted to top level. `validateSubmission`
     * walks from the fields that have no parent, so leaving `parentGroupId` set
     * would make it treat this entry as an empty form and accept anything.
     */
    const result = validateSubmission(
      { ...version, fields: fields.map((c) => ({ ...c, parentGroupId: null })) },
      draft,
    );

    if (!result.ok) {
      const message = result.errors[0]?.message;
      setError(message && isMessageKey(message) ? m(locale, message) : (message ?? m(locale, 'required')));
      return;
    }

    onDone(result.data);
  };

  return (
    <div className="flex flex-col gap-5 rounded-field border-2 border-brand-300 bg-brand-50/40 p-4">
      {questions.map((child) => (
        <div key={child.key} className="flex flex-col gap-2">
          <span className="text-field-base font-semibold text-slate-900">
            {t(child.label, locale, child.key)}
            {child.isRequired ? (
              <span aria-hidden className="ml-1 text-deny-500">
                *
              </span>
            ) : null}
          </span>
          {child.help ? (
            <span className="text-field-sm text-slate-600">{t(child.help, locale)}</span>
          ) : null}

          <QuestionInput
            field={child}
            config={resolveFieldConfig(child)}
            value={draft[child.key]}
            locale={locale}
            version={version}
            onChange={(next) => {
              setError(null);
              onDraftChange({ ...draft, [child.key]: next });
            }}
          />

          {/* A repeat inside a repeat has no sensible field UI and the engine
              gives it no child-of-child analytics view either. Guarded here so
              a mis-built form degrades to a message rather than a crash. */}
          {getFieldType(child.dataType).isContainer ? (
            <p className="text-field-sm text-amber-800">{m(locale, 'repeatNested')}</p>
          ) : null}
        </div>
      ))}

      {error ? (
        <p role="alert" className="rounded-field bg-deny-50 p-3 text-field-sm font-medium text-deny-700">
          {error}
        </p>
      ) : null}

      <div className="flex gap-3">
        <button
          type="button"
          onClick={onCancel}
          className="field-button w-auto shrink-0 border-2 border-slate-300 bg-white px-5 text-slate-800"
        >
          <X aria-hidden className="h-5 w-5" />
          {m(locale, 'cancel')}
        </button>
        <button type="button" onClick={submit} className="field-button bg-brand-600 text-white">
          <Check aria-hidden className="h-5 w-5" />
          {m(locale, 'repeatDone')}
        </button>
      </div>
    </div>
  );
}
