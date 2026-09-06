'use client';

import { useState } from 'react';
import { AlertTriangle, ArrowLeft, Check, UserCheck, UserPlus } from 'lucide-react';
import { t } from '@/lib/i18n';
import { m } from '@/lib/messages';

/**
 * "Is this the same person?"
 *
 * Shown after the last question and before saving, because that is the only
 * moment the answer is still one tap. Found afterwards, the same duplicate is a
 * cleanup job somebody has to be paid to do.
 *
 * Two things this screen has to get right, both learned the hard way:
 *
 *   - **Say what tapping does.** A card with a name and a chevron does not tell
 *     a worker that tapping it files their answers under that person. Each card
 *     now carries the words "Yes, this is them", and the choice is confirmed
 *     before anything is saved.
 *   - **Give them something to choose between.** The first version showed the
 *     name and the registration date, so two people called Test1 produced two
 *     identical cards and an unanswerable question. The cards now carry the
 *     answers that actually distinguish people — age, phone, guardian.
 *
 * There is no "merge" here, deliberately: nothing has been created yet, so the
 * choice is which record these answers belong to. Merging two records that both
 * already exist is a supervisor's job, on the person's profile.
 */

export interface DuplicateDetail {
  key: string;
  label: string;
  value: string;
}

export interface DuplicateCandidate {
  id: string;
  displayName: string;
  externalId: string | null;
  locationName: Record<string, string> | null;
  registeredAt: string;
  registeredByName: string | null;
  reasons: string[];
  /** The answers that tell this person apart from a namesake. */
  details: DuplicateDetail[];
}

export interface DuplicateCheckProps {
  candidates: DuplicateCandidate[];
  /**
   * Similar people registered outside this worker's places. A number, and
   * deliberately nothing else — see `findDuplicateCandidates`.
   */
  hiddenCount: number;
  locale: string;
  /** Field keys mapped to their question labels, for explaining a match. */
  fieldLabels: Record<string, string>;
  onPick: (subjectId: string) => void;
  onNew: () => void;
}

export function DuplicateCheck({
  candidates,
  hiddenCount,
  locale,
  fieldLabels,
  onPick,
  onNew,
}: DuplicateCheckProps) {
  const [confirming, setConfirming] = useState<DuplicateCandidate | null>(null);

  /*
   * Nothing is saved on the first tap. Choosing the wrong person here files a
   * beneficiary's answers under a stranger, and the worker gets no chance to
   * notice unless they are asked.
   */
  if (confirming) {
    return (
      <div className="flex min-h-dvh flex-col gap-6 px-5 py-6">
        <div>
          <h1 className="text-field-question font-semibold text-slate-900">
            {m(locale, 'confirmSamePerson', { name: confirming.displayName })}
          </h1>
          <p className="mt-2 text-field-sm text-slate-600">
            {m(locale, 'confirmSamePersonBody')}
          </p>
        </div>

        <div className="rounded-field border-2 border-brand-500 bg-brand-50 p-4">
          <PersonSummary candidate={confirming} locale={locale} fieldLabels={fieldLabels} />
        </div>

        <div className="sticky bottom-0 mt-auto -mx-5 flex flex-col gap-3 border-t border-slate-200 bg-white px-5 py-4">
          <button
            type="button"
            onClick={() => onPick(confirming.id)}
            className="field-button bg-affirm-500 text-white"
          >
            <Check aria-hidden className="h-5 w-5" />
            {m(locale, 'confirmSaveToPerson')}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(null)}
            className="field-button border-2 border-slate-300 bg-white text-slate-800"
          >
            <ArrowLeft aria-hidden className="h-5 w-5" />
            {m(locale, 'chooseAgain')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col gap-6 px-5 py-6">
      <div>
        <h1 className="text-field-question font-semibold text-slate-900">
          {m(locale, 'samePersonQuestion')}
        </h1>
        <p className="mt-2 text-field-sm text-slate-600">{m(locale, 'samePersonHint')}</p>
        <p className="mt-2 text-field-sm text-slate-600">{m(locale, 'samePersonHelp')}</p>
      </div>

      <ul className="flex flex-col gap-3">
        {candidates.map((candidate) => (
          <li key={candidate.id}>
            <button
              type="button"
              onClick={() => setConfirming(candidate)}
              // The whole card is the target, not a radio button beside a name.
              className="flex w-full flex-col gap-3 rounded-field border-2 border-slate-300 bg-white p-4 text-left active:border-brand-500 active:bg-brand-50"
            >
              <PersonSummary candidate={candidate} locale={locale} fieldLabels={fieldLabels} />

              {/* The words matter more than the chevron did: a worker has to be
                  able to see what tapping this will do before they tap it. */}
              <span className="flex min-h-tap items-center justify-center gap-2 rounded-field bg-brand-600 px-4 text-field-base font-semibold text-white">
                <UserCheck aria-hidden className="h-5 w-5" />
                {m(locale, 'thisIsThem')}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {hiddenCount > 0 ? (
        /*
         * A match in a place this worker does not cover. They are told that it
         * exists and nothing more — no name, no village. Enough to go and ask,
         * not enough to look anybody up.
         */
        <div className="flex gap-3 rounded-field border-2 border-amber-300 bg-amber-50 p-4">
          <AlertTriangle aria-hidden className="mt-0.5 h-6 w-6 shrink-0 text-amber-600" />
          <p className="text-field-sm text-amber-900">
            {hiddenCount === 1
              ? m(locale, 'someoneElsewhere')
              : m(locale, 'someoneElsewhereMany', { count: hiddenCount })}{' '}
            {m(locale, 'askSupervisor')}
          </p>
        </div>
      ) : null}

      <div className="sticky bottom-0 mt-auto -mx-5 border-t border-slate-200 bg-white px-5 py-4">
        <button
          type="button"
          onClick={onNew}
          className="field-button border-2 border-affirm-500 bg-white text-affirm-700"
        >
          <UserPlus aria-hidden className="h-5 w-5" />
          {/* Wording depends on what was actually shown: when every match was
              redacted there is no "this person" on screen to say no to. */}
          {candidates.length > 0 ? m(locale, 'noSomeoneNew') : m(locale, 'registerAnyway')}
        </button>
      </div>
    </div>
  );
}

/** Name, place, and the answers that tell two namesakes apart. */
function PersonSummary({
  candidate,
  locale,
  fieldLabels,
}: {
  candidate: DuplicateCandidate;
  locale: string;
  fieldLabels: Record<string, string>;
}) {
  const place = t(candidate.locationName, locale);

  return (
    <span className="flex w-full items-start gap-4">
      <UserCheck aria-hidden className="mt-0.5 h-7 w-7 shrink-0 text-brand-600" />
      <span className="min-w-0 flex-1">
        <span className="block text-field-lg font-semibold text-slate-900">
          {candidate.displayName}
        </span>

        {candidate.details.length > 0 ? (
          <span className="mt-1 block">
            {candidate.details.map((detail) => (
              <span key={detail.key} className="block text-field-sm text-slate-700">
                <span className="text-slate-500">{detail.label}:</span> {detail.value}
              </span>
            ))}
          </span>
        ) : null}

        <span className="mt-1 block text-field-sm text-slate-500">
          {[
            place,
            candidate.externalId,
            m(locale, 'registeredOn', { date: formatDate(candidate.registeredAt, locale) }),
            candidate.registeredByName
              ? m(locale, 'registeredBySomeone', { name: candidate.registeredByName })
              : '',
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>

        {/* Why this person came up. A match on a phone number is far stronger
            evidence than a similar name, and the worker deserves to know which
            one they are looking at. */}
        <span className="mt-1.5 flex flex-wrap gap-1.5">
          {candidate.reasons.map((reason) => (
            <span
              key={reason}
              className="rounded-full bg-slate-100 px-2 py-0.5 text-field-sm text-slate-700"
            >
              {reasonLabel(reason, locale, fieldLabels)}
            </span>
          ))}
        </span>
      </span>
    </span>
  );
}

function reasonLabel(
  reason: string,
  locale: string,
  fieldLabels: Record<string, string>,
): string {
  if (reason === 'name') return m(locale, 'matchedOnName');
  if (reason === 'external_id') return m(locale, 'matchedOnId');
  return m(locale, 'matchedOnAnswer', { field: fieldLabels[reason] ?? reason });
}

function formatDate(iso: string, locale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(locale === 'en' ? 'en-IN' : locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}
