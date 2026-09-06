'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, ShieldCheck, X } from 'lucide-react';
import { directionOf } from '@/lib/i18n';
import { m } from '@/lib/messages';

/**
 * Asking permission, before anything is collected.
 *
 * Worker-mediated: the notice is on the worker's phone and read aloud to
 * somebody who may not read, may not be holding the device, and is standing in
 * a doorway. So the screen is shaped around the act of reading rather than the
 * act of clicking — the words fill it, and the two answers are equally sized
 * and equally reachable.
 *
 * **No is a real answer, and it must not be harder to give than yes.** A
 * refusal is recorded, not treated as an abandoned form: "we asked and they
 * declined" and "we never asked" are different facts, and only one of them is
 * a compliance failure.
 *
 * Nothing here decides anything. It reports what happened and lets the caller
 * record it — which is what lets the same screen serve registration, a later
 * purpose, and re-consent at eighteen.
 */

export interface ConsentDecision {
  action: 'given' | 'refused';
  /** Seconds the notice was on screen. The only quality signal that exists. */
  secondsShown: number;
  readAloud: boolean;
  isMinor: boolean | null;
  guardianName: string | null;
  guardianRelationship: string | null;
}

export function ConsentStep({
  noticeText,
  noticeLocale,
  organisationName,
  /** Null when nothing on file settles it, which is when we have to ask. */
  isMinor,
  locale,
  onDecide,
  onBack,
}: {
  noticeText: string;
  noticeLocale: string;
  organisationName: string;
  isMinor: boolean | null;
  locale: string;
  onDecide: (decision: ConsentDecision) => void;
  onBack?: () => void;
}) {
  const openedAt = useRef(Date.now());
  const [readAloud, setReadAloud] = useState(false);
  /*
   * Three answers, not two, and until one of them is given there is no decision
   * to record.
   *
   * `null` used to mean both "not asked yet" and "18 or over": the buttons were
   * live from the start, so tapping straight through recorded
   * `subject_is_minor = null`, no guardian and no supervisor flag — a child
   * captured as an adult, invisible in the data and on the compliance screen.
   * `minor.ts` calls never defaulting to adult load-bearing.
   *
   * Gated rather than merely warned about, unlike the guardian's name below.
   * That distinction is the point: a name may genuinely not be knowable during
   * a visit, whereas the worker is looking at the person — and "Not sure" is
   * always an honest answer available in one tap, so nobody is stuck.
   */
  const [ageAnswer, setAgeAnswer] = useState<'minor' | 'adult' | 'unsure' | null>(
    isMinor === null ? null : isMinor ? 'minor' : 'adult',
  );
  const declaredMinor = ageAnswer === 'minor' ? true : ageAnswer === 'adult' ? false : null;
  const ageUnanswered = ageAnswer === null;
  const [guardianName, setGuardianName] = useState('');
  const [guardianRelationship, setGuardianRelationship] = useState('');

  // Restart the clock if the worker comes back to this screen.
  useEffect(() => {
    openedAt.current = Date.now();
  }, [noticeText]);

  const needsGuardian = declaredMinor === true;
  const guardianGiven = guardianName.trim() !== '';

  const decide = (action: 'given' | 'refused') =>
    onDecide({
      action,
      secondsShown: Math.round((Date.now() - openedAt.current) / 1000),
      readAloud,
      // Null now means the worker said they could not tell, never that nobody
      // asked. `form-capture` records that as `unknown` and flags it.
      isMinor: declaredMinor,
      guardianName: guardianName.trim() || null,
      guardianRelationship: guardianRelationship.trim() || null,
    });

  /*
   * What the worker is about to ask, in the words they would say.
   *
   * Named when a guardian has been given, because "they agreed" is ambiguous on
   * the one screen where it matters most: the child is in front of you and the
   * person whose permission counts is their mother.
   */
  const prompt = needsGuardian
    ? guardianGiven
      ? m(locale, 'consentAskGuardianNamed', { name: guardianName.trim() })
      : m(locale, 'consentAskGuardian')
    : m(locale, 'consentAskThem');

  return (
    <div className="flex min-h-dvh flex-col">
      <div className="flex flex-1 flex-col gap-5 px-5 py-6">
        <div className="flex items-start gap-3">
          <ShieldCheck aria-hidden className="mt-1 h-6 w-6 shrink-0 text-brand-700" />
          <div>
            <h1 className="text-field-question font-bold text-slate-900">
              {m(locale, 'consentTitle')}
            </h1>
            <p className="text-field-sm text-slate-600">
              {m(locale, 'consentReadAloud', { organisation: organisationName })}
            </p>
          </div>
        </div>

        {/*
         * The notice itself, in the language it was chosen in — which is not
         * necessarily the worker's. `dir` matters: an Urdu notice rendered
         * left-to-right is unreadable, and an unreadable notice is worse than
         * none because it still looks like consent was informed.
         */}
        <div
          lang={noticeLocale}
          dir={directionOf(noticeLocale)}
          className="whitespace-pre-line rounded-field border-2 border-slate-200 bg-white p-4 text-field-base leading-relaxed text-slate-900"
        >
          {noticeText}
        </div>

        <label className="flex min-h-tap items-center gap-3 text-field-base">
          <input
            type="checkbox"
            checked={readAloud}
            onChange={(event) => setReadAloud(event.target.checked)}
            className="h-6 w-6"
          />
          <span>{m(locale, 'consentDidReadAloud')}</span>
        </label>

        {/*
         * Asked directly when nothing on file settles it.
         *
         * A date of birth is better evidence and is used when it exists. When it
         * does not, the honest options are to ask or to guess, and guessing
         * "adult" is how a child's data gets collected with no guardian anywhere
         * in the record.
         */}
        {isMinor === null ? (
          <fieldset className="flex flex-col gap-2">
            <legend className="text-field-base font-semibold">{m(locale, 'consentIsMinor')}</legend>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setAgeAnswer('minor')}
                aria-pressed={ageAnswer === 'minor'}
                className={`field-button flex-1 border-2 ${
                  ageAnswer === 'minor'
                    ? 'border-brand-600 bg-brand-50 text-brand-800'
                    : 'border-slate-300 bg-white text-slate-800'
                }`}
              >
                {m(locale, 'yes')}
              </button>
              <button
                type="button"
                onClick={() => setAgeAnswer('adult')}
                aria-pressed={ageAnswer === 'adult'}
                className={`field-button flex-1 border-2 ${
                  ageAnswer === 'adult'
                    ? 'border-brand-600 bg-brand-50 text-brand-800'
                    : 'border-slate-300 bg-white text-slate-800'
                }`}
              >
                {m(locale, 'no')}
              </button>
            </div>
            {/* The third honest answer. Without it, gating the decision would
                trap a worker who genuinely cannot tell, and a trapped worker
                guesses — which is the failure this whole screen avoids. */}
            <button
              type="button"
              onClick={() => setAgeAnswer('unsure')}
              aria-pressed={ageAnswer === 'unsure'}
              className={`min-h-tap rounded-field border-2 px-4 text-field-base font-medium ${
                ageAnswer === 'unsure'
                  ? 'border-brand-600 bg-brand-50 text-brand-800'
                  : 'border-slate-300 bg-white text-slate-800'
              }`}
            >
              {m(locale, 'consentAgeUnsure')}
            </button>
            {ageAnswer === 'unsure' ? (
              <p className="text-field-sm text-amber-800">
                {m(locale, 'consentAgeUnsureNote')}
              </p>
            ) : null}
          </fieldset>
        ) : null}

        {needsGuardian ? (
          <fieldset className="flex flex-col gap-2 rounded-field bg-amber-50 p-4">
            <legend className="text-field-base font-semibold text-amber-900">
              {m(locale, 'consentGuardianNeeded')}
            </legend>
            <p className="text-field-sm text-amber-800">{m(locale, 'consentGuardianWhy')}</p>
            <input
              value={guardianName}
              onChange={(event) => setGuardianName(event.target.value)}
              placeholder={m(locale, 'consentGuardianName')}
              className="field-control"
            />
            <input
              value={guardianRelationship}
              onChange={(event) => setGuardianRelationship(event.target.value)}
              placeholder={m(locale, 'consentGuardianRelationship')}
              className="field-control"
            />
            {!guardianGiven ? (
              /*
               * Said, not enforced by a disabled button. The worker can still
               * proceed — a supervisor reviews it afterwards — because a worker
               * blocked mid-visit by a missing name will put in a fake one, and
               * a fake guardian is worse than a recorded gap.
               */
              <p className="text-field-sm text-amber-900">{m(locale, 'consentGuardianMissing')}</p>
            ) : null}
          </fieldset>
        ) : null}

      </div>

      {/*
       * The decision is pinned to the bottom of the screen.
       *
       * It used to sit at the end of the page under `mt-auto`, which never
       * engaged: this notice is long, the page always overflows, and measuring it
       * on a 390x844 phone put both answers about 1100px below the fold —
       * further still once the guardian panel opened. A worker who had just typed
       * a guardian's name saw a warning sentence and no way forward, which is
       * exactly how it was reported. Same `sticky bottom-0` treatment the capture
       * screen uses for Next and Save, and for the same reason.
       */}
      <div className="sticky bottom-0 flex flex-col gap-3 border-t-2 border-slate-200 bg-white px-5 py-4">
        <p className="text-field-base font-semibold text-slate-900">{prompt}</p>

        {/*
         * Yes and no, the same size and the same distance from the thumb.
         * Making refusal smaller or greyer would be a nudge, and consent that
         * was nudged is not freely given.
         */}
        <button
          type="button"
          disabled={ageUnanswered}
          onClick={() => decide('given')}
          className="field-button bg-affirm-600 text-white disabled:opacity-40"
        >
          <Check aria-hidden className="h-6 w-6" />
          {needsGuardian ? m(locale, 'consentYesGuardian') : m(locale, 'consentYes')}
        </button>
        <button
          type="button"
          disabled={ageUnanswered}
          onClick={() => decide('refused')}
          className="field-button border-2 border-deny-300 bg-white text-deny-700 disabled:opacity-40"
        >
          <X aria-hidden className="h-6 w-6" />
          {m(locale, 'consentNo')}
        </button>

        {/* A reminder, never a block. The obligation is to read it out; refusing
            to record an answer until a checkbox is ticked would only teach
            workers to tick it without reading. */}
        {!readAloud ? (
          <p className="text-field-sm text-amber-800">{m(locale, 'consentStillToRead')}</p>
        ) : null}

        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            className="min-h-tap text-field-base font-medium text-brand-700"
          >
            {m(locale, 'back')}
          </button>
        ) : null}
      </div>
    </div>
  );
}
