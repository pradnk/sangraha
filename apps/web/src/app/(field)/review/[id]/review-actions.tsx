'use client';

import { useActionState, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, Check, Info, RotateCcw } from 'lucide-react';
import { m } from '@/lib/messages';
import { submitReview, type ReviewState } from '../actions';

/**
 * Approve / send back.
 *
 * Rejection expands to reveal a required note before it can be submitted. A
 * record bounced back with no explanation just gets re-sent unchanged, so the
 * reason is not optional — and asking for it only after the supervisor has
 * chosen "send back" keeps the common path (approve) to a single tap.
 */
export function ReviewActions({
  submissionId,
  locale,
}: {
  submissionId: string;
  locale: string;
}) {
  const [state, formAction, pending] = useActionState<ReviewState, FormData>(submitReview, {});
  const [rejecting, setRejecting] = useState(false);
  const router = useRouter();

  /*
   * A decision sends the supervisor back to the queue, which is where they are
   * going next anyway. Held back when there is something to tell them — an
   * admin who just approved their own record should read that before the
   * screen changes under them.
   *
   * In an effect rather than during render: navigating mid-render is a side
   * effect React is entitled to run twice.
   */
  const returnImmediately = state.done && !state.notice;

  useEffect(() => {
    if (!returnImmediately) return;
    router.push('/review');
    router.refresh();
  }, [returnImmediately, router]);

  if (state.done && state.notice) {
    return (
      <div className="sticky bottom-0 flex flex-col gap-3 border-t border-slate-200 bg-white px-5 py-4">
        <p
          role="status"
          className="flex items-start gap-3 rounded-field bg-brand-50 p-4 text-field-sm text-brand-900"
        >
          <Info aria-hidden className="mt-0.5 h-5 w-5 shrink-0" />
          {state.notice}
        </p>
        <button
          type="button"
          onClick={() => {
            router.push('/review');
            router.refresh();
          }}
          className="field-button bg-brand-600 text-white"
        >
          {m(locale, 'backToList')}
        </button>
      </div>
    );
  }

  return (
    <div className="sticky bottom-0 flex flex-col gap-3 border-t border-slate-200 bg-white px-5 py-4">
      {state.error ? (
        <p
          role="alert"
          className="flex items-start gap-3 rounded-field bg-deny-50 p-4 text-field-sm font-medium text-deny-700"
        >
          <AlertCircle aria-hidden className="mt-0.5 h-5 w-5 shrink-0" />
          {state.error}
        </p>
      ) : null}

      {rejecting ? (
        <form action={formAction} className="flex flex-col gap-3">
          <input type="hidden" name="submissionId" value={submissionId} />
          <input type="hidden" name="decision" value="rejected" />
          <label className="flex flex-col gap-2">
            <span className="text-field-base font-semibold text-slate-800">
              {m(locale, 'reviewNotePrompt')}
            </span>
            <textarea name="note" rows={3} required className="field-control py-3" autoFocus />
          </label>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setRejecting(false)}
              className="field-button w-auto shrink-0 border-2 border-slate-300 bg-white px-6 text-slate-800"
            >
              {m(locale, 'back')}
            </button>
            <button
              type="submit"
              disabled={pending}
              className="field-button bg-deny-500 text-white disabled:opacity-60"
            >
              <RotateCcw aria-hidden className="h-5 w-5" />
              {pending ? m(locale, 'saving') : m(locale, 'confirm')}
            </button>
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-3">
          <form action={formAction}>
            <input type="hidden" name="submissionId" value={submissionId} />
            <input type="hidden" name="decision" value="approved" />
            <button
              type="submit"
              disabled={pending}
              className="field-button bg-affirm-500 text-white disabled:opacity-60"
            >
              <Check aria-hidden className="h-5 w-5" />
              {pending ? m(locale, 'saving') : m(locale, 'approve')}
            </button>
          </form>
          <button
            type="button"
            onClick={() => setRejecting(true)}
            className="field-button border-2 border-deny-500 bg-white text-deny-700"
          >
            <RotateCcw aria-hidden className="h-5 w-5" />
            {m(locale, 'sendBack')}
          </button>
        </div>
      )}
    </div>
  );
}
