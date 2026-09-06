'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, ArrowLeft, Check, Link2, Link2Off, User } from 'lucide-react';
import { SubjectPicker, type PickerSubject } from '@/components/field/subject-picker';
import { m } from '@/lib/messages';
import { markDuplicateAction, unmarkDuplicateAction } from './actions';

/**
 * "This is the same person as…"
 *
 * A supervisor's control, and reversible in one tap. The whole reason this is a
 * link rather than a merge is that the person doing it is working from a name
 * and a village, and will sometimes be wrong — so being wrong has to cost
 * nothing but a second tap.
 *
 * The choice is confirmed before anything is written, and the confirmation says
 * which of the two records survives. Without that, "this is the same person as
 * X" leaves it genuinely unclear whether X is being folded into this record or
 * the other way round.
 */
export function DuplicateLink({
  subjectId,
  subjectName,
  subjectDetails,
  subjectTypeId,
  locale,
  linkedTo,
}: {
  subjectId: string;
  /** The person whose profile this is — the record that will be folded away. */
  subjectName: string;
  /** Their identifying answers, so both records can be compared like for like. */
  subjectDetails: { key: string; label: string; value: string }[];
  subjectTypeId: string;
  locale: string;
  /** Name of the record this one is folded into, when it already is. */
  linkedTo?: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [picking, setPicking] = useState(false);
  const [confirming, setConfirming] = useState<PickerSubject | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = (action: () => Promise<{ error?: string }>) =>
    startTransition(async () => {
      const result = await action();
      setError(result.error ?? null);
      if (!result.error) {
        setPicking(false);
        setConfirming(null);
        router.refresh();
      }
    });

  if (linkedTo) {
    return (
      <section className="border-t border-slate-200 pt-5">
        <button
          type="button"
          disabled={pending}
          onClick={() => run(() => unmarkDuplicateAction(subjectId))}
          className="field-button border-2 border-slate-300 bg-white text-slate-800 disabled:opacity-60"
        >
          <Link2Off aria-hidden className="h-5 w-5" />
          {m(locale, 'undoSamePerson')}
        </button>
      </section>
    );
  }

  if (confirming) {
    return (
      <section className="flex flex-col gap-4 border-t border-slate-200 pt-5">
        <h2 className="text-field-lg font-semibold text-slate-900">
          {m(locale, 'confirmJoinTitle')}
        </h2>

        {/* Both records, side by side and labelled. Which one survives is the
            thing a supervisor most needs to be sure of before tapping. */}
        <div className="flex flex-col gap-3">
          <RecordCard
            heading={m(locale, 'thisRecordIs')}
            name={subjectName}
            details={subjectDetails}
            tone="muted"
          />
          <RecordCard
            heading={m(locale, 'theOtherRecordIs')}
            name={confirming.displayName}
            details={confirming.details}
            tone="kept"
          />
        </div>

        <p className="text-field-sm text-slate-600">{m(locale, 'confirmJoinBody')}</p>

        <button
          type="button"
          disabled={pending}
          onClick={() => run(() => markDuplicateAction(subjectId, confirming.id))}
          className="field-button bg-affirm-500 text-white disabled:opacity-60"
        >
          <Check aria-hidden className="h-5 w-5" />
          {m(locale, 'confirmJoin')}
        </button>
        <button
          type="button"
          onClick={() => setConfirming(null)}
          className="field-button border-2 border-slate-300 bg-white text-slate-800"
        >
          <ArrowLeft aria-hidden className="h-5 w-5" />
          {m(locale, 'chooseAgain')}
        </button>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-4 border-t border-slate-200 pt-5">
      {error ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-field bg-deny-50 p-4 text-field-sm text-deny-700"
        >
          <AlertCircle aria-hidden className="mt-0.5 h-5 w-5 shrink-0" />
          {error}
        </p>
      ) : null}

      {picking ? (
        <>
          <h2 className="text-field-lg font-semibold text-slate-900">
            {m(locale, 'markSamePerson')}
          </h2>
          {/* Restricted to the same kind of subject: a Student is never the
              same person as a Household. */}
          <SubjectPicker
            locale={locale}
            subjectTypeId={subjectTypeId}
            excludeId={subjectId}
            autoFocus
            onPick={(other) => setConfirming(other)}
          />
          <button
            type="button"
            onClick={() => setPicking(false)}
            className="field-button border-2 border-slate-300 bg-white text-slate-800"
          >
            {m(locale, 'back')}
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => setPicking(true)}
          className="field-button border-2 border-slate-300 bg-white text-slate-800"
        >
          <Link2 aria-hidden className="h-5 w-5" />
          {m(locale, 'markSamePerson')}
        </button>
      )}
    </section>
  );
}

function RecordCard({
  heading,
  name,
  details,
  tone,
}: {
  heading: string;
  name: string;
  details?: { key: string; label: string; value: string }[];
  tone: 'kept' | 'muted';
}) {
  return (
    <div
      className={
        tone === 'kept'
          ? 'rounded-field border-2 border-brand-500 bg-brand-50 p-4'
          : 'rounded-field border-2 border-slate-300 bg-slate-50 p-4'
      }
    >
      <p className="text-field-sm font-medium text-slate-500">{heading}</p>
      <div className="mt-1 flex items-start gap-3">
        <User
          aria-hidden
          className={`mt-0.5 h-6 w-6 shrink-0 ${tone === 'kept' ? 'text-brand-700' : 'text-slate-400'}`}
        />
        <div className="min-w-0">
          <p className="text-field-base font-semibold text-slate-900">{name}</p>
          {details?.length ? (
            <div className="mt-0.5">
              {details.map((detail) => (
                <p key={detail.key} className="text-field-sm text-slate-700">
                  <span className="text-slate-500">{detail.label}:</span> {detail.value}
                </p>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
