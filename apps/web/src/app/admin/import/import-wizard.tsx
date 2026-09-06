'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  FileSpreadsheet,
  Link2,
  Loader2,
  Upload,
} from 'lucide-react';
import type { ColumnGuess, FieldDataType, I18nText, TableProblem } from '@sangraha/form-engine';
import { localise } from '@sangraha/form-engine';
import { PLAIN_NAMES } from '@/components/admin/field-palette';

/**
 * Bringing a spreadsheet in, in two steps.
 *
 * Never one. An organisation moving off Excel is importing years of records,
 * and the guesses this makes about their columns become the shape of their data
 * for good — so the middle screen, where every guess is shown with the evidence
 * behind it and can be changed, is the feature. The upload is just how the file
 * arrives.
 */

export interface SubjectTypeChoice {
  id: string;
  name: I18nText;
  code: string;
}

interface Analysis {
  label: string;
  rowCount: number;
  truncated: boolean;
  duplicateRows: number[];
  columns: ColumnGuess[];
}

interface Decision {
  header: string;
  dataType: string;
  format?: string;
  choices?: string[];
  isRequired: boolean;
  isUnique: boolean;
  include: boolean;
}

interface Outcome {
  formSlug: string;
  imported: number;
  subjectsCreated: number;
  skippedCells: { row: number; header: string; value: string }[];
}

/** Types worth offering as an override, in the order an admin would think. */
const OVERRIDES: FieldDataType[] = [
  'short_text',
  'long_text',
  'integer',
  'number',
  'date',
  'datetime',
  'boolean',
  'single_choice',
  'phone',
];

export function ImportWizard({
  subjectTypes,
  locale,
}: {
  subjectTypes: SubjectTypeChoice[];
  locale: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<TableProblem[]>([]);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const [formName, setFormName] = useState('');
  const [formType, setFormType] = useState<'registration' | 'standalone'>('standalone');
  const [subjectTypeId, setSubjectTypeId] = useState(subjectTypes[0]?.id ?? '');
  const [nameColumns, setNameColumns] = useState<string[]>([]);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [sheetUrl, setSheetUrl] = useState('');

  /*
   * The chosen file is kept here and sent again on confirm, rather than being
   * held on the server between the two steps. Nothing to expire, nothing to
   * secure, and no chance of confirming against a table that has been evicted.
   */
  const file = useRef<File | null>(null);

  const reset = () => {
    setError(null);
    setProblems([]);
  };

  async function analyse(body: FormData | string) {
    reset();
    setBusy(true);
    try {
      const response = await fetch('/api/import/analyse', {
        method: 'POST',
        ...(typeof body === 'string'
          ? { headers: { 'content-type': 'application/json' }, body }
          : { body }),
      });
      const payload = (await response.json()) as Partial<Analysis> & {
        error?: string;
        problems?: TableProblem[];
      };

      if (payload.problems) {
        setProblems(payload.problems);
        return;
      }
      if (!response.ok || !payload.columns) {
        setError(payload.error ?? 'That file could not be read.');
        return;
      }

      const found = payload as Analysis;
      setAnalysis(found);
      setDecisions(
        found.columns.map((column) => ({
          header: column.header,
          dataType: column.dataType,
          format: column.format,
          choices: column.choices,
          // Offered only where the evidence supports it: required where nothing
          // is blank, unique where nothing repeats.
          isRequired: column.blanks === 0,
          isUnique: false,
          include: true,
        })),
      );
      if (!formName) setFormName(suggestName(found.label));
      setNameColumns(found.columns[0] ? [found.columns[0].header] : []);
    } catch {
      setError('That file could not be read. Check it opens in a spreadsheet and try again.');
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!analysis) return;
    reset();
    setBusy(true);
    try {
      const plan = {
        formName,
        formType,
        subjectTypeId: formType === 'registration' ? subjectTypeId : null,
        displayNameColumns: nameColumns,
        columns: decisions,
      };

      /*
       * The plan travels in whichever body shape the source needs — multipart
       * beside the re-sent file, or JSON beside the sheet link. It is the same
       * plan either way, and sending the sheet without it is what used to make
       * every Google Sheets import fail at the last button.
       */
      let request: RequestInit;
      if (file.current) {
        const body = new FormData();
        body.set('file', file.current);
        body.set('plan', JSON.stringify(plan));
        request = { method: 'POST', body };
      } else {
        request = {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sheetUrl, plan }),
        };
      }

      const response = await fetch('/api/import/commit', request);

      const payload = (await response.json()) as Partial<Outcome> & { error?: string };
      if (!response.ok || payload.imported === undefined) {
        setError(payload.error ?? 'The import could not be finished.');
        return;
      }
      setOutcome(payload as Outcome);
    } catch {
      setError('The import could not be finished. Nothing was changed.');
    } finally {
      setBusy(false);
    }
  }

  const update = (index: number, patch: Partial<Decision>) =>
    setDecisions((current) =>
      current.map((decision, i) => (i === index ? { ...decision, ...patch } : decision)),
    );

  if (outcome) return <Done outcome={outcome} />;

  if (analysis) {
    return (
      <Review
        analysis={analysis}
        decisions={decisions}
        formName={formName}
        formType={formType}
        subjectTypes={subjectTypes}
        subjectTypeId={subjectTypeId}
        nameColumns={nameColumns}
        locale={locale}
        busy={busy}
        error={error}
        onName={setFormName}
        onFormType={setFormType}
        onSubjectType={setSubjectTypeId}
        onNameColumns={setNameColumns}
        onUpdate={update}
        onBack={() => setAnalysis(null)}
        onCommit={commit}
      />
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-bold">Bring in a spreadsheet</h1>
        <p className="mt-1 text-slate-600">
          Upload the file your team already keeps, and Sangraha builds a form from its columns and
          brings the records in with it. Nothing is created until you have seen what it worked out.
        </p>
      </div>

      {error ? <Problem>{error}</Problem> : null}
      {problems.length > 0 ? <Problems problems={problems} /> : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-5">
          <h2 className="flex items-center gap-2 font-semibold">
            <FileSpreadsheet aria-hidden className="h-5 w-5 text-brand-600" />
            A file from your computer
          </h2>
          <p className="text-sm text-slate-600">
            Excel (.xlsx) or CSV, up to 5 MB and 5,000 rows. The first row must be the column
            headings.
          </p>
          <label className="inline-flex cursor-pointer items-center gap-2 self-start rounded-lg bg-brand-600 px-4 py-2 font-medium text-white hover:bg-brand-700">
            <Upload aria-hidden className="h-4 w-4" />
            Choose a file
            <input
              type="file"
              accept=".csv,.txt,.xlsx,.xlsm,.xls"
              className="hidden"
              disabled={busy}
              onChange={(event) => {
                const chosen = event.target.files?.[0];
                if (!chosen) return;
                file.current = chosen;
                const body = new FormData();
                body.set('file', chosen);
                void analyse(body);
              }}
            />
          </label>
        </section>

        <section className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-5">
          <h2 className="flex items-center gap-2 font-semibold">
            <Link2 aria-hidden className="h-5 w-5 text-brand-600" />
            A Google Sheet
          </h2>
          <p className="text-sm text-slate-600">
            Paste the address from your browser while the sheet is open. It must be shared with
            this installation, or with anyone who has the link.
          </p>
          <input
            value={sheetUrl}
            disabled={busy}
            onChange={(event) => setSheetUrl(event.target.value)}
            placeholder="https://docs.google.com/spreadsheets/d/…"
            className="rounded border border-slate-300 px-3 py-2"
          />
          <button
            type="button"
            disabled={busy || sheetUrl.trim() === ''}
            onClick={() => {
              file.current = null;
              void analyse(JSON.stringify({ sheetUrl }));
            }}
            className="self-start rounded-lg bg-brand-600 px-4 py-2 font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            Read the sheet
          </button>
        </section>
      </div>

      {busy ? (
        <p className="flex items-center gap-2 text-slate-600">
          <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
          Reading…
        </p>
      ) : null}
    </div>
  );
}

function Review({
  analysis,
  decisions,
  formName,
  formType,
  subjectTypes,
  subjectTypeId,
  nameColumns,
  locale,
  busy,
  error,
  onName,
  onFormType,
  onSubjectType,
  onNameColumns,
  onUpdate,
  onBack,
  onCommit,
}: {
  analysis: Analysis;
  decisions: Decision[];
  formName: string;
  formType: 'registration' | 'standalone';
  subjectTypes: SubjectTypeChoice[];
  subjectTypeId: string;
  nameColumns: string[];
  locale: string;
  busy: boolean;
  error: string | null;
  onName: (value: string) => void;
  onFormType: (value: 'registration' | 'standalone') => void;
  onSubjectType: (value: string) => void;
  onNameColumns: (value: string[]) => void;
  onUpdate: (index: number, patch: Partial<Decision>) => void;
  onBack: () => void;
  onCommit: () => void;
}) {
  const included = decisions.filter((d) => d.include).length;

  return (
    <div className="flex flex-col gap-5">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1.5 self-start text-brand-700 hover:underline"
      >
        <ArrowLeft aria-hidden className="h-4 w-4" />
        Choose a different file
      </button>

      <div>
        <h1 className="text-xl font-bold">Check what was found</h1>
        <p className="mt-1 text-slate-600">
          <strong>{analysis.rowCount}</strong> {analysis.rowCount === 1 ? 'record' : 'records'} in{' '}
          <span className="font-medium">{analysis.label}</span>, across {decisions.length}{' '}
          {decisions.length === 1 ? 'column' : 'columns'}. Every guess below can be changed, and
          nothing is created until you say so.
        </p>
      </div>

      {error ? <Problem>{error}</Problem> : null}

      {analysis.truncated ? (
        <Warning>
          Only the first {analysis.rowCount} rows were read — the limit for one import. Bring these
          in, then import the rest as a second file.
        </Warning>
      ) : null}

      {analysis.duplicateRows.length > 0 ? (
        <Warning>
          {analysis.duplicateRows.length}{' '}
          {analysis.duplicateRows.length === 1 ? 'row is identical to' : 'rows are identical to'} an
          earlier row (
          {analysis.duplicateRows.slice(0, 8).join(', ')}
          {analysis.duplicateRows.length > 8 ? '…' : ''}). They will all be brought in — remove them
          in the spreadsheet first if they are mistakes.
        </Warning>
      ) : null}

      <section className="flex flex-col gap-4 rounded-lg border border-slate-200 bg-white p-5">
        <label className="flex flex-col gap-1.5">
          <span className="font-medium">What should this form be called?</span>
          <input
            value={formName}
            onChange={(event) => onName(event.target.value)}
            maxLength={120}
            className="max-w-md rounded border border-slate-300 px-3 py-2"
          />
        </label>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 font-medium">What are these records?</legend>
          {[
            {
              value: 'standalone' as const,
              label: 'One-off records',
              hint: 'A survey, a list of events. Not about a particular person.',
            },
            {
              value: 'registration' as const,
              label: 'People you work with',
              hint: 'Each row is a person. They appear under Find a person once imported.',
            },
          ].map((choice) => (
            <label
              key={choice.value}
              className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-200 p-3 hover:bg-slate-50 has-[:checked]:border-brand-500 has-[:checked]:bg-brand-50"
            >
              <input
                type="radio"
                name="importFormType"
                checked={formType === choice.value}
                onChange={() => onFormType(choice.value)}
                className="mt-1"
              />
              <span>
                <span className="block font-medium">{choice.label}</span>
                <span className="block text-xs text-slate-500">{choice.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {formType === 'registration' ? (
          subjectTypes.length === 0 ? (
            <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
              You have not set up anyone to register yet.{' '}
              <Link href="/admin/subject-types" className="font-medium underline">
                Add a type first
              </Link>{' '}
              — a Student, a Household — then come back.
            </p>
          ) : (
            <div className="flex flex-col gap-3 sm:flex-row">
              <label className="flex flex-col gap-1.5">
                <span className="font-medium">Who are they?</span>
                <select
                  value={subjectTypeId}
                  onChange={(event) => onSubjectType(event.target.value)}
                  className="rounded border border-slate-300 px-3 py-2"
                >
                  {subjectTypes.map((type) => (
                    <option key={type.id} value={type.id}>
                      {localise(type.name, locale, type.code)}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex flex-col gap-1.5">
                <span className="font-medium">Which column is their name?</span>
                <select
                  value={nameColumns[0] ?? ''}
                  onChange={(event) => onNameColumns([event.target.value])}
                  className="rounded border border-slate-300 px-3 py-2"
                >
                  {decisions
                    .filter((d) => d.include)
                    .map((decision) => (
                      <option key={decision.header} value={decision.header}>
                        {decision.header}
                      </option>
                    ))}
                </select>
              </label>
            </div>
          )
        ) : null}
      </section>

      <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        <table className="min-w-full border-collapse text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th className="px-4 py-2.5 text-left font-medium">Bring in</th>
              <th className="px-4 py-2.5 text-left font-medium">Column</th>
              <th className="px-4 py-2.5 text-left font-medium">Becomes</th>
              <th className="px-4 py-2.5 text-left font-medium">What is in it</th>
              <th className="px-4 py-2.5 text-left font-medium">Rules</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {analysis.columns.map((column, index) => {
              const decision = decisions[index]!;
              return (
                <tr key={column.header} className={decision.include ? '' : 'opacity-40'}>
                  <td className="px-4 py-3 align-top">
                    <input
                      type="checkbox"
                      checked={decision.include}
                      aria-label={`Bring in ${column.header}`}
                      onChange={(event) => onUpdate(index, { include: event.target.checked })}
                      className="h-4 w-4"
                    />
                  </td>
                  <td className="px-4 py-3 align-top font-medium">{column.header}</td>
                  <td className="px-4 py-3 align-top">
                    <select
                      value={decision.dataType}
                      disabled={!decision.include}
                      onChange={(event) =>
                        onUpdate(index, {
                          dataType: event.target.value,
                          // A type the admin picked themselves carries no
                          // format guess with it.
                          format: event.target.value === column.dataType ? column.format : undefined,
                        })
                      }
                      className="rounded border border-slate-300 px-2 py-1.5"
                    >
                      {OVERRIDES.map((type) => (
                        <option key={type} value={type}>
                          {PLAIN_NAMES[type]?.name ?? type}
                        </option>
                      ))}
                    </select>
                    {decision.format ? (
                      <span className="mt-1 block text-xs text-brand-700">
                        checked as {decision.format}
                      </span>
                    ) : null}
                    {decision.dataType === 'single_choice' && column.choices ? (
                      <span className="mt-1 block text-xs text-slate-500">
                        {column.choices.length} choices
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 align-top text-slate-600">
                    {/* The evidence for the guess, so it can be judged rather
                        than merely accepted. */}
                    <span className="block font-mono text-xs">
                      {column.samples.join(' · ') || '—'}
                    </span>
                    {column.blanks > 0 ? (
                      <span className="mt-1 block text-xs text-amber-700">
                        {column.blanks} blank
                      </span>
                    ) : null}
                    {column.misfits.length > 0 ? (
                      <span className="mt-1 block text-xs text-amber-700">
                        {column.misfits.length} will not fit (row{' '}
                        {column.misfits
                          .slice(0, 3)
                          .map((m) => m.row)
                          .join(', ')}
                        ) — left blank
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 align-top">
                    <label className="flex items-center gap-1.5 text-xs">
                      <input
                        type="checkbox"
                        checked={decision.isRequired}
                        disabled={!decision.include || column.blanks > 0}
                        onChange={(event) => onUpdate(index, { isRequired: event.target.checked })}
                      />
                      Required
                    </label>
                    <label className="mt-1 flex items-center gap-1.5 text-xs">
                      <input
                        type="checkbox"
                        checked={decision.isUnique}
                        disabled={!decision.include}
                        onChange={(event) => onUpdate(index, { isUnique: event.target.checked })}
                      />
                      No repeats
                      {column.looksUnique ? (
                        <span className="text-brand-700">· none repeat</span>
                      ) : null}
                    </label>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={busy || included === 0 || formName.trim().length < 2}
          onClick={onCommit}
          className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-5 py-2.5 font-medium text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {busy ? (
            <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
          ) : (
            <CheckCircle2 aria-hidden className="h-4 w-4" />
          )}
          Create the form and bring in {analysis.rowCount}{' '}
          {analysis.rowCount === 1 ? 'record' : 'records'}
        </button>
        <span className="text-sm text-slate-500">
          {included} of {decisions.length} columns will become questions.
        </span>
      </div>
    </div>
  );
}

function Done({ outcome }: { outcome: Outcome }) {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start gap-3 rounded-lg border border-affirm-500 bg-affirm-50 p-5">
        <CheckCircle2 aria-hidden className="mt-0.5 h-6 w-6 shrink-0 text-affirm-700" />
        <div>
          <h1 className="text-lg font-bold text-affirm-700">
            Imported {outcome.imported} {outcome.imported === 1 ? 'record' : 'records'}.
          </h1>
          {outcome.subjectsCreated > 0 ? (
            <p className="mt-1 text-affirm-700">
              {outcome.subjectsCreated} people are now in the registry and can be found by name.
            </p>
          ) : null}
        </div>
      </div>

      {outcome.skippedCells.length > 0 ? (
        <section className="flex flex-col gap-2 rounded-lg border border-amber-300 bg-amber-50 p-4">
          <p className="font-medium text-amber-900">
            {outcome.skippedCells.length}{' '}
            {outcome.skippedCells.length === 1 ? 'cell' : 'cells'} could not be read and were left
            blank. The records were brought in.
          </p>
          <ul className="flex flex-col gap-0.5 text-sm text-amber-900">
            {outcome.skippedCells.slice(0, 12).map((cell) => (
              <li key={`${cell.row}-${cell.header}`}>
                row {cell.row} · {cell.header} · “{cell.value}”
              </li>
            ))}
          </ul>
          {outcome.skippedCells.length > 12 ? (
            <p className="text-sm text-amber-900">
              …and {outcome.skippedCells.length - 12} more.
            </p>
          ) : null}
          <a
            href={`data:text/csv;charset=utf-8,${encodeURIComponent(
              `Row,Column,Value\n${outcome.skippedCells
                .map((c) => `${c.row},"${c.header.replaceAll('"', '""')}","${c.value.replaceAll('"', '""')}"`)
                .join('\n')}`,
            )}`}
            download="cells-not-imported.csv"
            className="self-start text-sm font-medium text-amber-900 underline"
          >
            Download the list
          </a>
        </section>
      ) : null}

      <div className="flex flex-wrap gap-3">
        <Link
          href={`/admin/records/${outcome.formSlug}`}
          className="rounded-lg bg-brand-600 px-4 py-2 font-medium text-white hover:bg-brand-700"
        >
          See the records
        </Link>
        <Link
          href={`/admin/forms/${outcome.formSlug}`}
          className="rounded-lg border border-slate-300 px-4 py-2 font-medium hover:bg-slate-50"
        >
          Edit the form
        </Link>
        <Link
          href="/admin/import"
          className="rounded-lg border border-slate-300 px-4 py-2 font-medium hover:bg-slate-50"
        >
          Import another
        </Link>
      </div>
    </div>
  );
}

function Problem({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className="flex items-start gap-2 rounded-lg bg-deny-50 p-3 text-deny-700">
      <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
      {children}
    </p>
  );
}

function Warning({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-amber-900">
      <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/** The things that have to be fixed in the spreadsheet, not here. */
function Problems({ problems }: { problems: TableProblem[] }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-deny-300 bg-deny-50 p-4 text-deny-700">
      <p className="font-medium">That spreadsheet needs a small fix first.</p>
      <ul className="flex list-disc flex-col gap-1 pl-5">
        {problems.map((problem, index) => (
          <li key={index}>
            {problem.kind === 'no_headers'
              ? 'The first row should be the column headings, and it is empty.'
              : problem.kind === 'empty'
                ? 'There are headings but no records underneath them.'
                : problem.kind === 'blank_header'
                  ? `Column ${problem.column + 1} has no heading. Give it one, or delete the column.`
                  : `Two columns are both called “${problem.header}”. Rename one of them.`}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A form name from the file name, so the field is rarely empty. */
function suggestName(label: string): string {
  const base = label.replace(/\.(csv|txt|xlsx|xlsm|xls)$/i, '').replace(/[_-]+/g, ' ').trim();
  if (!base || base.toLowerCase() === 'google sheet') return '';
  return base.charAt(0).toUpperCase() + base.slice(1);
}
