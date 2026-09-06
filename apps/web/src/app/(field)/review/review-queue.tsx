'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Check, CheckSquare, ChevronRight, Info, Loader2, Square } from 'lucide-react';
import { m } from '@/lib/messages';
import { approveManyAction, type BulkReviewState } from './actions';

/**
 * The supervisor's queue, with an option to clear several at once.
 *
 * Most of this queue is routine — an attendance record a supervisor can judge
 * from the one-line summary. Making them open fifty screens to say yes fifty
 * times is how a review step stops being done at all, which is worse for the
 * data than a fast one.
 *
 * So both paths stay. Tapping a record still opens it, which is the only way to
 * send one back; the checkbox is an addition beside it, not a replacement.
 */

export interface QueueRow {
  id: string;
  title: string;
  summary: string;
  submittedByName: string | null;
  submittedAt: string;
  /** True when the reviewer sent it and the four-eyes rule blocks them. */
  isOwnAndBlocked: boolean;
}

export function ReviewQueue({ rows, locale }: { rows: QueueRow[]; locale: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<BulkReviewState | null>(null);

  // A supervisor's own submissions can never be approved by them, so they are
  // not selectable — better than letting them tick a box and be told afterwards.
  const selectable = rows.filter((row) => !row.isOwnAndBlocked);
  const allSelected = selectable.length > 0 && selected.size === selectable.length;

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const leaveSelection = () => {
    setSelecting(false);
    setSelected(new Set());
    setConfirming(false);
  };

  const approve = () =>
    startTransition(async () => {
      const outcome = await approveManyAction([...selected]);
      setResult(outcome);
      leaveSelection();
      router.refresh();
    });

  if (confirming) {
    return (
      <div className="flex min-h-dvh flex-col gap-6 px-5 py-6">
        <div>
          <h1 className="text-field-question font-semibold text-slate-900">
            {m(locale, 'confirmApproveMany', { count: selected.size })}
          </h1>
          {/* Approving cannot be undone, so the count and that fact are the
              two things this screen exists to say. */}
          <p className="mt-2 text-field-sm text-slate-600">
            {m(locale, 'confirmApproveManyBody')}
          </p>
        </div>

        <ul className="flex flex-col gap-2">
          {rows
            .filter((row) => selected.has(row.id))
            .map((row) => (
              <li
                key={row.id}
                className="rounded-field border-2 border-slate-200 bg-white px-4 py-3"
              >
                <p className="text-field-base font-semibold text-slate-900">{row.title}</p>
                {row.summary ? (
                  <p className="text-field-sm text-slate-600">{row.summary}</p>
                ) : null}
              </li>
            ))}
        </ul>

        <div className="sticky bottom-0 mt-auto -mx-5 flex flex-col gap-3 border-t border-slate-200 bg-white px-5 py-4">
          <button
            type="button"
            disabled={pending}
            onClick={approve}
            className="field-button bg-affirm-500 text-white disabled:opacity-60"
          >
            {pending ? (
              <Loader2 aria-hidden className="h-5 w-5 animate-spin" />
            ) : (
              <Check aria-hidden className="h-5 w-5" />
            )}
            {m(locale, 'approveSelected', { count: selected.size })}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="field-button border-2 border-slate-300 bg-white text-slate-800"
          >
            <ArrowLeft aria-hidden className="h-5 w-5" />
            {m(locale, 'back')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 px-5 py-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-field-lg font-bold text-slate-900">
          {m(locale, 'reviewQueue')}
          {rows.length > 0 ? (
            <span className="ml-2 text-field-base font-normal text-slate-500">({rows.length})</span>
          ) : null}
        </h1>

        {selectable.length > 1 ? (
          <button
            type="button"
            onClick={() => (selecting ? leaveSelection() : setSelecting(true))}
            className="ml-auto min-h-tap rounded-field border-2 border-slate-300 px-4 text-field-sm font-semibold text-slate-800"
          >
            {selecting ? m(locale, 'doneChecking') : m(locale, 'checkSeveral')}
          </button>
        ) : null}
      </div>

      {/* Every outcome, including the ones that did not happen — a partial
          result reported as success leaves a queue looking empty. */}
      {result?.summary ? (
        <div
          role="status"
          className="flex items-start gap-3 rounded-field bg-brand-50 p-4 text-field-sm text-brand-900"
        >
          <Info aria-hidden className="mt-0.5 h-5 w-5 shrink-0" />
          <span>
            {result.summary.map((line) => (
              <span key={line} className="block">
                {line}
              </span>
            ))}
          </span>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <p className="rounded-field bg-affirm-50 p-5 text-field-base text-affirm-700">
          {m(locale, 'nothingToReview')}
        </p>
      ) : null}

      {selecting ? (
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() =>
              setSelected(allSelected ? new Set() : new Set(selectable.map((row) => row.id)))
            }
            className="min-h-tap flex-1 rounded-field border-2 border-slate-300 px-4 text-field-sm font-semibold text-slate-800"
          >
            {allSelected ? m(locale, 'clearSelection') : m(locale, 'selectAll')}
          </button>
        </div>
      ) : null}

      {rows.map((row) =>
        selecting ? (
          <SelectableRow
            key={row.id}
            row={row}
            locale={locale}
            checked={selected.has(row.id)}
            onToggle={() => toggle(row.id)}
          />
        ) : (
          <Link
            key={row.id}
            href={`/review/${row.id}`}
            className="flex min-h-tap-lg items-center gap-3 rounded-field border-2 border-slate-200 bg-white px-4 py-3"
          >
            <RowBody row={row} locale={locale} />
            <ChevronRight aria-hidden className="h-5 w-5 shrink-0 text-slate-400" />
          </Link>
        ),
      )}

      {selecting && selected.size > 0 ? (
        <div className="sticky bottom-0 -mx-5 border-t border-slate-200 bg-white px-5 py-4">
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="field-button bg-affirm-500 text-white"
          >
            <Check aria-hidden className="h-5 w-5" />
            {m(locale, 'approveSelected', { count: selected.size })}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function SelectableRow({
  row,
  locale,
  checked,
  onToggle,
}: {
  row: QueueRow;
  locale: string;
  checked: boolean;
  onToggle: () => void;
}) {
  if (row.isOwnAndBlocked) {
    return (
      // The reason sits under the row rather than beside it: on a 360px screen
      // it otherwise squeezes the summary into an ellipsis, hiding the very
      // thing the supervisor is reading.
      <div className="flex min-h-tap-lg flex-col gap-1 rounded-field border-2 border-dashed border-slate-200 bg-slate-50 px-4 py-3">
        <div className="flex items-center gap-3">
          <Square aria-hidden className="h-6 w-6 shrink-0 text-slate-300" />
          <RowBody row={row} locale={locale} muted />
        </div>
        <p className="pl-9 text-field-sm font-medium text-slate-500">
          {m(locale, 'youSentThis')}
        </p>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={checked}
      className={`flex min-h-tap-lg w-full items-center gap-3 rounded-field border-2 px-4 py-3 text-left ${
        checked ? 'border-brand-500 bg-brand-50' : 'border-slate-200 bg-white'
      }`}
    >
      {checked ? (
        <CheckSquare aria-hidden className="h-6 w-6 shrink-0 text-brand-600" />
      ) : (
        <Square aria-hidden className="h-6 w-6 shrink-0 text-slate-400" />
      )}
      <RowBody row={row} locale={locale} />
    </button>
  );
}

function RowBody({ row, locale, muted }: { row: QueueRow; locale: string; muted?: boolean }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-1">
      <span
        className={`truncate text-field-base font-semibold ${muted ? 'text-slate-500' : 'text-slate-900'}`}
      >
        {row.title}
      </span>
      {row.summary ? (
        <span className="truncate text-field-sm text-slate-600">{row.summary}</span>
      ) : null}
      <span className="text-field-sm text-slate-500">
        {m(locale, 'submittedBy')} {row.submittedByName ?? '—'} ·{' '}
        {new Intl.DateTimeFormat(`${locale}-IN`, { day: 'numeric', month: 'short' }).format(
          new Date(row.submittedAt),
        )}
      </span>
    </span>
  );
}
