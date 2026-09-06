'use client';

import { useState } from 'react';
import { AlertTriangle, Archive, ArchiveRestore, Trash2 } from 'lucide-react';
import type { FieldDefinition, I18nText, RuleNode } from '@sangraha/form-engine';
import {
  TEXT_FORMATS,
  canBeUnique,
  formatExample,
  getFieldType,
  isValidMask,
  localise,
  pruneBlank,
  type TextFormat,
} from '@sangraha/form-engine';
import { UI_LOCALES, LANGUAGE_NAMES } from '@/lib/i18n';
import { RuleEditor } from './rule-editor';
import { PLAIN_NAMES } from './field-palette';

export interface OptionSetSummary {
  id: string;
  code: string;
  name: I18nText;
  options: { code: string; label: I18nText }[];
}

/**
 * The panel for one question.
 *
 * Everything here writes on blur or on change rather than behind a Save button:
 * the preview beside it is the feedback, and an editor with an unsaved state is
 * an editor someone will close and lose work in.
 */
export function FieldEditor({
  field,
  earlierFields,
  optionSets,
  purposes,
  answerCount,
  locale,
  onPatch,
  onDelete,
  onArchive,
  busy,
}: {
  field: FieldDefinition;
  earlierFields: FieldDefinition[];
  optionSets: OptionSetSummary[];
  /** For attributing the question to a reason it is collected. */
  purposes: { id: string; code: string; name: Record<string, string> }[];
  answerCount: number;
  locale: string;
  onPatch: (patch: Record<string, unknown>) => void;
  onDelete: () => void;
  onArchive: (archived: boolean) => void;
  busy: boolean;
}) {
  const definition = getFieldType(field.dataType);
  const config = (field.config ?? {}) as Record<string, unknown>;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const machineLocales = Object.entries(field.labelMachine ?? {})
    .filter(([, isMachine]) => isMachine)
    .map(([loc]) => loc);
  // The hint has its own machine-translation flags, and its own boxes to
  // highlight — `helpMachine`, not `labelMachine`.
  const helpMachineLocales = Object.entries(field.helpMachine ?? {})
    .filter(([, isMachine]) => isMachine)
    .map(([loc]) => loc);

  /*
   * `pruneBlank` matters here, not just for tidiness.
   *
   * An input per language means tabbing through them writes `''` for each one
   * touched, and a stored `''` is indistinguishable from a real translation to
   * anything reading it — which is how a Kannada worker ended up looking at a
   * blank question. Blanks are dropped so the language is simply untranslated.
   *
   * `reviewedLocale` tells the server a person typed this, so the
   * machine-translated flag for that language clears.
   */
  const setLabel = (loc: string, value: string) =>
    onPatch({ label: pruneBlank({ ...field.label, [loc]: value }), reviewedLocale: loc });

  return (
    <div className="flex flex-col gap-5">
      <div>
        <p className="text-xs uppercase tracking-wide text-slate-500">
          {PLAIN_NAMES[field.dataType]?.name ?? field.dataType}
        </p>
        {/* The key is shown, quietly, because it is what an analyst will see as
            a column name and an admin occasionally needs to match them up. */}
        <p className="font-mono text-xs text-slate-400">{field.key}</p>
      </div>

      {answerCount > 0 ? (
        <p className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-xs text-amber-900">
          <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          {answerCount} {answerCount === 1 ? 'answer has' : 'answers have'} already been collected
          for this question. Renaming it is safe; changing its type or removing it is restricted.
        </p>
      ) : null}

      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          The question
        </h3>
        {machineLocales.length > 0 ? (
          <p className="rounded bg-amber-50 p-2 text-xs text-amber-900">
            Highlighted translations were made automatically and have not been checked. Edit one to
            mark it as yours.
          </p>
        ) : null}
        {UI_LOCALES.map((loc) => (
          <label key={loc} className="flex items-center gap-2">
            <span className="w-16 shrink-0 text-xs text-slate-500">{LANGUAGE_NAMES[loc]}</span>
            <input
              defaultValue={field.label[loc] ?? ''}
              onBlur={(event) => setLabel(loc, event.target.value)}
              placeholder={loc === 'en' ? 'What are you asking?' : 'Translation'}
              className={`w-full rounded border px-2 py-1.5 ${
                machineLocales.includes(loc) ? 'border-amber-400 bg-amber-50' : 'border-slate-300'
              }`}
            />
          </label>
        ))}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Hint below the question
        </h3>
        {/*
         * One input per locale, with no English fallback in any of them — the
         * same shape as the label editor above, and for a reason that only
         * shows up here.
         *
         * This was a single box reading `help?.[locale] ?? help?.en ?? ''` while
         * its `onBlur` wrote to `[locale]` and marked it reviewed. So with the
         * editor set to Hindi and a hint that existed only in English, the box
         * arrived pre-filled with English and merely *tabbing through it* saved
         * that English text as `help.hi`, human-reviewed. `missingLocales`
         * stopped reporting it and auto-translate never filled it: the gap
         * closed itself while staying a gap.
         */}
        {UI_LOCALES.map((loc) => (
          <label key={loc} className="flex items-center gap-2">
            <span className="w-16 shrink-0 text-xs text-slate-500">{LANGUAGE_NAMES[loc]}</span>
            <input
              defaultValue={field.help?.[loc] ?? ''}
              onBlur={(event) => {
                const next = pruneBlank({ ...field.help, [loc]: event.target.value });
                onPatch({
                  help: Object.keys(next).length > 0 ? next : null,
                  reviewedLocale: loc,
                });
              }}
              placeholder={loc === 'en' ? 'Optional' : 'Translation'}
              className={`w-full rounded border px-2 py-1.5 ${
                helpMachineLocales.includes(loc)
                  ? 'border-amber-400 bg-amber-50'
                  : 'border-slate-300'
              }`}
            />
          </label>
        ))}
      </section>

      {/*
       * Why this is being collected.
       *
       * The one input that turns the form builder into a privacy notice: the
       * system already knows every question it asks, so once each is
       * attributed, the itemised notice the law requires can be generated
       * instead of written. Unset is honest and allowed — the Privacy screen
       * lists what is unaccounted for rather than forcing a guess here.
       */}
      <label className="flex flex-col gap-1">
        <span className="text-sm">Why do you collect this?</span>
        {purposes.length === 0 ? (
          <span className="text-xs text-slate-500">
            No reasons set up yet.{' '}
            <a href="/admin/privacy" className="text-brand-700 underline">
              Add one under Privacy
            </a>{' '}
            and this question can be explained to people.
          </span>
        ) : (
          <select
            value={field.purposeId ?? ''}
            onChange={(event) => onPatch({ purposeId: event.target.value || null })}
            className={`w-full rounded border px-2 py-1.5 text-sm ${
              field.purposeId ? 'border-slate-300' : 'border-amber-400 bg-amber-50/40'
            }`}
          >
            <option value="">Not said yet</option>
            {purposes.map((purpose) => (
              <option key={purpose.id} value={purpose.id}>
                {purpose.name[locale] || purpose.name.en || purpose.code}
              </option>
            ))}
          </select>
        )}
      </label>

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={field.isRequired}
          onChange={(event) => onPatch({ isRequired: event.target.checked })}
          className="h-4 w-4"
        />
        <span>An answer is required</span>
      </label>

      {/*
       * Offered only where it can mean something. Unique on a yes/no question
       * would cap the form at two records ever; on a photo or a repeating
       * section there is nothing sensible to compare.
       */}
      {canBeUnique(field.dataType) ? (
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={field.isUnique}
            onChange={(event) => onPatch({ isUnique: event.target.checked })}
            className="mt-1 h-4 w-4"
          />
          <span>
            <span className="block">No two records may have the same answer</span>
            <span className="block text-xs text-slate-500">
              For a phone number, an email, a ration card or an ID number. Capitals and spaces at
              the ends are ignored when comparing, so <code>ABC123 </code> and <code>abc123</code>{' '}
              count as the same answer.
            </span>
          </span>
        </label>
      ) : null}

      {/*
       * What kind of text, for the questions where that means something.
       *
       * Here rather than as a family of field types, so an organisation can
       * describe a format nobody anticipated — a state ration card number —
       * without waiting for a release.
       */}
      {field.dataType === 'short_text' ? (
        <TextFormatPicker
          value={(config.format as TextFormat) ?? 'any'}
          pattern={typeof config.formatPattern === 'string' ? config.formatPattern : ''}
          answerCount={answerCount}
          busy={busy}
          onChange={(next) => onPatch({ config: { ...config, ...next } })}
        />
      ) : null}

      {definition.usesOptions ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Answers to choose from
          </h3>
          <select
            value={field.optionSet?.id ?? ''}
            onChange={(event) => onPatch({ optionSetId: event.target.value || null })}
            className="w-full rounded border border-slate-300 px-2 py-1.5"
          >
            <option value="">Choose a list…</option>
            {optionSets.map((set) => (
              <option key={set.id} value={set.id}>
                {localise(set.name, locale, set.code)} ({set.options.length})
              </option>
            ))}
          </select>
          {field.optionSet ? (
            <ul className="flex flex-wrap gap-1.5">
              {field.optionSet.options.map((option) => (
                <li
                  key={option.code}
                  className="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-700"
                >
                  {localise(option.label, locale, option.code)}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-deny-700">
              This question cannot be published until it has a list of answers.
            </p>
          )}
        </section>
      ) : null}

      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          When to ask it
        </h3>
        <RuleEditor
          field={field}
          earlierFields={earlierFields}
          locale={locale}
          onChange={(rule: RuleNode | null) => onPatch({ visibilityRule: rule })}
        />
      </section>

      <section className="flex flex-col gap-2 border-t border-slate-200 pt-4">
        {field.isArchived ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => onArchive(false)}
            className="inline-flex items-center gap-2 self-start rounded-lg border border-slate-300 px-3 py-1.5 hover:bg-slate-50"
          >
            <ArchiveRestore aria-hidden className="h-4 w-4" />
            Ask this question again
          </button>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => onArchive(true)}
            className="inline-flex items-center gap-2 self-start rounded-lg border border-slate-300 px-3 py-1.5 hover:bg-slate-50"
          >
            <Archive aria-hidden className="h-4 w-4" />
            Stop asking this question
          </button>
        )}

        {/* Deleting is offered only when nothing would be lost. With answers
            present the server refuses and explains; hiding the button here
            means the admin is not invited to try. */}
        {answerCount === 0 ? (
          confirmDelete ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={onDelete}
                className="rounded-lg bg-deny-500 px-3 py-1.5 font-medium text-white"
              >
                Delete for good
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="rounded-lg border border-slate-300 px-3 py-1.5"
              >
                Keep it
              </button>
            </div>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirmDelete(true)}
              className="inline-flex items-center gap-2 self-start rounded-lg border border-deny-300 px-3 py-1.5 text-deny-700 hover:bg-deny-50"
            >
              <Trash2 aria-hidden className="h-4 w-4" />
              Delete this question
            </button>
          )
        ) : (
          <p className="text-xs text-slate-500">
            This question cannot be deleted because it holds answers. Stop asking it instead — the
            answers stay in your reports.
          </p>
        )}
      </section>
    </div>
  );
}


/** Names an admin would use, not the ones the code uses. */
const FORMAT_LABELS: Record<TextFormat, string> = {
  any: 'Anything',
  email: 'Email address',
  url: 'Web address',
  pan: 'PAN',
  aadhaar: 'Aadhaar number',
  pincode: 'Pincode',
  ifsc: 'IFSC code',
  pattern: 'A pattern I set',
};

/**
 * "What kind of text?"
 *
 * The custom option takes a mask — `A` for a letter, `9` for a digit — rather
 * than a regular expression. An admin can read it back and see whether it is
 * right, a mistake can only ever be the wrong shape rather than catastrophic,
 * and it describes Indian ID numbers exactly.
 */
function TextFormatPicker({
  value,
  pattern,
  answerCount,
  busy,
  onChange,
}: {
  value: TextFormat;
  pattern: string;
  answerCount: number;
  busy: boolean;
  onChange: (next: { format: TextFormat; formatPattern?: string }) => void;
}) {
  const [draft, setDraft] = useState(pattern);
  const example = formatExample(value, draft);
  const patternInvalid = value === 'pattern' && draft.trim() !== '' && !isValidMask(draft);

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        What kind of text?
      </h3>

      <select
        value={value}
        disabled={busy}
        onChange={(event) =>
          onChange({ format: event.target.value as TextFormat, formatPattern: draft })
        }
        className="w-full rounded border border-slate-300 px-2 py-1.5"
      >
        {TEXT_FORMATS.map((format) => (
          <option key={format} value={format}>
            {FORMAT_LABELS[format]}
          </option>
        ))}
      </select>

      {value === 'pattern' ? (
        <>
          <input
            value={draft}
            disabled={busy}
            placeholder="AAAAA9999A"
            maxLength={40}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => onChange({ format: 'pattern', formatPattern: draft })}
            className={`w-full rounded border px-2 py-1.5 font-mono ${
              patternInvalid ? 'border-deny-500' : 'border-slate-300'
            }`}
          />
          <p className="text-xs text-slate-500">
            <strong>A</strong> is any letter, <strong>9</strong> is any digit. Everything else has
            to appear exactly — so <code>AA99/9999</code> accepts <code>KA01/2345</code>.
          </p>
          {patternInvalid ? (
            <p className="text-xs text-deny-700">
              Use only A, 9, spaces, and - / . — and at least one A or 9.
            </p>
          ) : null}
        </>
      ) : null}

      {example && value !== 'pattern' ? (
        <p className="text-xs text-slate-500">
          Answers must look like <code>{example}</code>.
        </p>
      ) : null}

      {/* Tightening a rule cannot reach backwards over answers already given,
          and an admin who thinks it has would trust a guarantee the data does
          not meet. */}
      {answerCount > 0 && value !== 'any' ? (
        <p className="text-xs text-amber-700">
          {answerCount} {answerCount === 1 ? 'answer has' : 'answers have'} already been collected.
          They are kept as they are; this applies to new ones.
        </p>
      ) : null}
    </section>
  );
}
