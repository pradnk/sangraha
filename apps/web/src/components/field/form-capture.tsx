'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Loader2 } from 'lucide-react';
import {
  evaluateCalc,
  hashNoticeText,
  resolveFieldConfig,
  validateSubmission,
  visibleFields,
  type CalcNode,
  type FieldDefinition,
  type FormVersionDefinition,
  type SubmissionData,
} from '@sangraha/form-engine';
import { t } from '@/lib/i18n';
import { isMessageKey, m } from '@/lib/messages';
import { enqueueSubmission, queueConsentEvents } from '@/lib/submission-queue';
import { DuplicateCheck, type DuplicateCandidate } from './duplicate-check';
import { QuestionInput } from './question-input';
import { ConsentStep, type ConsentDecision } from './consent-step';

/**
 * One question per screen.
 *
 * The single biggest usability decision in the product. A long scrolling form
 * loses the worker's place, makes it unclear which error belongs to which
 * question, and shrinks every target. One question filling the screen removes
 * all three problems at once, and makes skip logic feel like the form simply
 * not asking rather than fields appearing and disappearing under the thumb.
 */

export interface ConsentRequirement {
  noticeVersionId: string;
  noticeText: string;
  noticeLocale: string;
  noticeSha256: string | null;
  organisationName: string;
  /** Every purpose this notice covers that actually needs asking. */
  purposeIds: string[];
  /** Null when nothing on file settles it, so the worker is asked directly. */
  isMinor: boolean | null;
  minorBasis: 'dob' | 'age_field' | 'worker_declared' | 'unknown';
}

export interface FormCaptureProps {
  version: FormVersionDefinition;
  locale: string;
  locationId: string | null;
  subjectId?: string | null;
  subjectName?: string | null;
  /**
   * Ask "is this the same person?" before saving.
   *
   * Set only for registration forms whose subject type is known. An encounter
   * is already attached to somebody, and a standalone form registers nobody,
   * so neither has anything to duplicate.
   */
  checkDuplicates?: boolean;
  /**
   * The notice to read out, and what agreeing to it means.
   *
   * Absent when the organisation has not published one yet, or when every
   * purpose this form serves rests on a Section 7 legitimate use — in which
   * case there is nothing to ask and asking would imply a withdrawal the
   * organisation cannot honour.
   */
  consent?: ConsentRequirement | null;
  /**
   * Runs the real capture UI without saving anything, for the builder's live
   * preview. Deliberately the same component rather than a mock: a preview that
   * is a separate implementation is a preview that drifts, and the admin is
   * relying on it to tell them what a field worker will actually see.
   */
  preview?: boolean;
  /**
   * The record being rewritten, when a supervisor sent one back.
   *
   * Its answers seed the form, so the worker fixes the one thing that was
   * wrong instead of re-keying a visit they already made. Re-entering
   * everything is not merely tedious — it is how a correction introduces a
   * second mistake in an answer that was right the first time.
   */
  correction?: { submissionId: string; answers: SubmissionData } | null;
}

/**
 * Turns a validation failure into words the worker can act on.
 *
 * Field types report a message *key* — `invalidEmail`, `invalidDate` — so the
 * engine can stay free of any particular language. Nothing was translating
 * them, so a worker who mistyped a date was shown the literal string
 * `invalidDate`. Anything without a translation falls through unchanged, which
 * covers Zod's own messages.
 */
function explain(locale: string, message: string | undefined): string {
  if (!message) return m(locale, 'required');
  return isMessageKey(message) ? m(locale, message) : message;
}

export function FormCapture({
  version,
  locale,
  locationId,
  subjectId,
  subjectName,
  checkDuplicates = false,
  consent = null,
  preview = false,
  correction = null,
}: FormCaptureProps) {
  /*
   * A correction gets its own draft key.
   *
   * Sharing one with a fresh capture of the same form would let a half-finished
   * new visit reappear inside a correction, and the corrected answers reappear
   * in the next new visit. Keyed on the record being fixed, because that is
   * what the draft is about.
   */
  const draftKey = correction
    ? `mis.correction.${correction.submissionId}`
    : `mis.draft.${version.id}${subjectId ? `.${subjectId}` : ''}`;

  const [data, setData] = useState<SubmissionData>({});
  const [index, setIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  /*
   * `consenting` comes first, before a single question is asked. Permission has
   * to precede collection, not follow it — asking afterwards means the answers
   * already exist when the person says no.
   */
  const [state, setState] = useState<
    'consenting' | 'filling' | 'checking' | 'deciding' | 'saving' | 'done' | 'refused'
  >(consent ? 'consenting' : 'filling');
  const [consentEvents, setConsentEvents] = useState<Record<string, unknown>[]>([]);
  const [restored, setRestored] = useState(false);
  /*
   * A hash of the words this device actually put on the screen.
   *
   * It used to send back `consent.noticeSha256` — the server's own published
   * hash — which made the comparison on the way in a tautology and
   * `notice_mismatch` permanently false. A phone rendering a stale cached
   * notice is the whole scenario the column exists for, and echoing the
   * server's answer is precisely what cannot detect it.
   *
   * Null where `crypto.subtle` is unavailable (an insecure origin), which the
   * server reads as "could not check" rather than as a mismatch.
   */
  const [renderedSha256, setRenderedSha256] = useState<string | null>(null);
  const [matches, setMatches] = useState<{
    candidates: DuplicateCandidate[];
    hiddenCount: number;
  } | null>(null);

  // Restore any in-progress draft. A killed browser, a phone call or a flat
  // battery mid-form must not cost the worker their answers.
  useEffect(() => {
    if (preview) {
      setRestored(true);
      return;
    }
    try {
      const raw = window.localStorage.getItem(draftKey);
      if (raw) setData(JSON.parse(raw) as SubmissionData);
      // No draft in hand: a correction starts from what was actually sent, a
      // new capture from nothing.
      else if (correction) setData(correction.answers);
    } catch {
      // A corrupt draft starts from the stored answers where there are some,
      // rather than losing them along with the draft.
      if (correction) setData(correction.answers);
    }
    setRestored(true);
  }, [draftKey, preview, correction]);

  // Autosave on every change, not on a timer — a timer loses the last few
  // seconds, which is exactly when a form is most likely to be interrupted.
  // Held back until the restore has run, so an empty initial state cannot
  // overwrite a draft that is about to be loaded.
  useEffect(() => {
    if (!restored || preview) return;
    window.localStorage.setItem(draftKey, JSON.stringify(data));
  }, [data, draftKey, restored, preview]);

  useEffect(() => {
    const text = consent?.noticeText;
    if (!text || typeof crypto?.subtle?.digest !== 'function') {
      setRenderedSha256(null);
      return;
    }

    /*
     * `hashNoticeText`, not a digest of our own. It normalises line endings and
     * trailing whitespace before hashing, and the publisher used it — so
     * hashing the raw string here would differ on formatting alone and flag
     * every single consent as a mismatch. A false alarm on all of them would be
     * worse than the missing check it replaces.
     */
    let current = true;
    void hashNoticeText(text)
      .then((digest) => {
        if (current) setRenderedSha256(digest);
      })
      .catch(() => {
        if (current) setRenderedSha256(null);
      });

    return () => {
      current = false;
    };
  }, [consent?.noticeText]);

  const topLevel = useMemo(
    () => version.fields.filter((f) => !f.parentGroupId),
    [version.fields],
  );

  // Recomputed on every answer, so skip logic takes effect immediately: the
  // questions a worker is asked always match what they have said so far.
  const questions = useMemo(() => visibleFields(topLevel, data), [topLevel, data]);

  const withCalculations = useCallback(
    (next: SubmissionData): SubmissionData => {
      const result = { ...next };
      for (const field of topLevel) {
        if (field.dataType !== 'calculated') continue;
        const config = resolveFieldConfig(field) as { formula?: CalcNode };
        if (config.formula) result[field.key] = evaluateCalc(config.formula, result);
      }
      return result;
    },
    [topLevel],
  );

  const setAnswer = (field: FieldDefinition, value: unknown) => {
    setError(null);
    setData((current) => withCalculations({ ...current, [field.key]: value }));
  };

  const current = questions[Math.min(index, Math.max(0, questions.length - 1))];
  const isLast = index >= questions.length - 1;

  /** Validates just this question, so an error is always next to its answer. */
  const validateCurrent = (): boolean => {
    if (!current) return true;
    const single: FormVersionDefinition = {
      ...version,
      fields: [{ ...current, visibilityRule: null }],
    };
    const result = validateSubmission(single, data);
    if (result.ok) return true;
    setError(explain(locale, result.errors[0]?.message));
    return false;
  };

  /**
   * Records what the worker was told happened, and moves on or stops.
   *
   * Built here rather than in `ConsentStep` so the screen stays a screen: it
   * reports a decision, and this decides what that means for each purpose the
   * notice covers.
   */
  const decideConsent = (decision: ConsentDecision) => {
    if (!consent) return;

    const isMinor = decision.isMinor;
    /*
     * The worker was asked and said they could not tell. `ConsentStep` now
     * refuses to record a decision before one of its three answers is given, so
     * this is a stated "I do not know" rather than a question nobody reached.
     */
    const ageUnknown = isMinor === null;
    const needsGuardian = isMinor === true;
    const guardianVerified = needsGuardian ? decision.guardianName !== null : null;

    setConsentEvents(
      consent.purposeIds.map((purposeId) => ({
        clientEventUuid: crypto.randomUUID(),
        /*
         * Who this is about, when that is already known — an encounter form, or
         * a registration attached to somebody who exists.
         *
         * It was never set, which quietly disabled the whole refusal path:
         * `RefusedScreen` filters on exactly this key and so always found
         * nothing, for every form. `/api/submissions` overwrites it with the
         * subject it creates or resolves, so carrying it here changes nothing
         * about a record that *is* saved — only about one that is not.
         */
        subjectId: subjectId ?? null,
        purposeId,
        action: decision.action,
        // A child's consent rests on the guardian's authority, not their own.
        lawfulBasis: needsGuardian ? 'guardian_consent' : 'consent',
        noticeVersionId: consent.noticeVersionId,
        noticeLocale: consent.noticeLocale,
        // What was shown, not what was published — see `renderedSha256`.
        noticeTextSha256: renderedSha256,
        noticeSecondsShown: decision.secondsShown,
        noticeReadAloud: decision.readAloud,
        clientOccurredAt: new Date().toISOString(),
        subjectIsMinor: isMinor,
        /*
         * How we knew, not just what we concluded. "Her recorded date of birth",
         * "the worker said so" and "nobody could tell" are three different
         * answers to the same question, and the third used to be recorded as
         * the second — `worker_declared` for a worker who declared nothing.
         */
        minorBasis: ageUnknown
          ? 'unknown'
          : consent.isMinor === null
            ? 'worker_declared'
            : consent.minorBasis,
        guardianName: decision.guardianName,
        guardianRelationship: decision.guardianRelationship,
        guardianVerified,
        /*
         * A child with no named guardian is not blocked — it goes to a
         * supervisor. A worker stopped mid-visit invents a name.
         *
         * An unknown age goes to the same queue. It cannot be counted among
         * children (`subject_is_minor` is null, which is the truth), so without
         * this it would appear nowhere at all — and "we do not know whether this
         * was a child" is precisely the thing a supervisor should see.
         */
        pendingOverride: (needsGuardian && !guardianVerified) || ageUnknown,
      })),
    );

    /*
     * A refusal ends it, and is still recorded — through the standalone
     * endpoint, since there is no submission to carry it. "We asked and they
     * declined" and "we never asked" are different facts, and only one of them
     * is a failure.
     */
    if (decision.action === 'refused') {
      setState('refused');
      return;
    }

    setState('filling');
  };

  const goNext = () => {
    if (!validateCurrent()) return;
    setError(null);
    setIndex((i) => Math.min(i + 1, questions.length - 1));
  };

  const goBack = () => {
    setError(null);
    setIndex((i) => Math.max(0, i - 1));
  };

  /** Queues the submission. `attachTo` overrides the subject it belongs to. */
  const commit = useCallback(
    async (answers: SubmissionData, attachTo: string | null) => {
      setState('saving');
      const result = await enqueueSubmission({
        clientUuid: crypto.randomUUID(),
        formVersionId: version.id,
        subjectId: attachTo,
        locationId,
        data: answers,
        // Turns this send into a rewrite of an existing record rather than a
        // new one. Absent on a first capture, which is every other caller.
        correctsSubmissionId: correction?.submissionId,
        deviceMeta: { userAgent: navigator.userAgent, online: navigator.onLine },
        // Travels with the record because at registration the subject does not
        // exist until the server creates it, inside the same transaction.
        consent: consentEvents.length > 0 ? consentEvents : undefined,
      });

      /*
       * A question marked unique already holds this answer.
       *
       * Sent back to the offending question rather than shown as a dead end:
       * the worker is standing in front of the person and can read the number
       * out again. The draft is deliberately kept — they have not finished.
       */
      if (result.outcome === 'duplicate') {
        const first = result.issues[0];
        const position = questions.findIndex((q) => q.key === first?.fieldKey);
        if (position >= 0) setIndex(position);
        setError(
          first
            ? m(locale, 'alreadyUsed', { question: first.label })
            : m(locale, 'required'),
        );
        setState('filling');
        return;
      }

      window.localStorage.removeItem(draftKey);
      setState('done');
    },
    [consentEvents, draftKey, locale, locationId, questions, version.id, correction],
  );

  const save = async () => {
    if (!validateCurrent()) return;

    const result = validateSubmission(version, data);
    if (!result.ok) {
      // Jump to the first offending question rather than reporting a list the
      // worker then has to hunt through.
      const firstBadKey = result.errors[0]?.fieldKey;
      const position = questions.findIndex((q) => q.key === firstBadKey);
      if (position >= 0) setIndex(position);
      setError(explain(locale, result.errors[0]?.message));
      return;
    }

    if (preview) {
      // Nothing is queued or stored; the admin still sees the confirmation
      // screen, which is part of what they are previewing.
      setState('done');
      return;
    }

    if (checkDuplicates && version.subjectTypeId) {
      setState('checking');
      try {
        const response = await fetch('/api/subjects/duplicates', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ subjectTypeId: version.subjectTypeId, data: result.data }),
        });

        if (response.ok) {
          const found = (await response.json()) as {
            visible: DuplicateCandidate[];
            hiddenCount: number;
          };
          if (found.visible.length > 0 || found.hiddenCount > 0) {
            setMatches({ candidates: found.visible, hiddenCount: found.hiddenCount });
            setState('deciding');
            return;
          }
        }
      } catch {
        /*
         * The check needs the network; registration must not. A worker in a
         * village with no signal still has a person in front of them, and
         * refusing to save would lose real data to prevent a hypothetical
         * duplicate. Falls through and saves.
         */
      }
    }

    await commit(result.data, subjectId ?? null);
  };

  /**
   * Clears the screen for the next person.
   *
   * Every trace of the last one goes, the consent included. Those events are an
   * attestation about a named individual: carrying them into the next
   * registration would record the second person as having agreed to something
   * nobody read them. Worse, it would not even show up as a mistake — the
   * events keep the first person's `clientEventUuid`s, the server recognises
   * them as a replay, and the second person ends up with no consent row at all.
   *
   * So the notice is read again from the top wherever there is one, which is
   * also simply the truth: this is a different person and they have not been
   * asked yet.
   */
  const startAnother = () => {
    setData({});
    setIndex(0);
    setError(null);
    setMatches(null);
    setConsentEvents([]);
    setState(consent ? 'consenting' : 'filling');
  };

  if (state === 'consenting' && consent) {
    return (
      <ConsentStep
        noticeText={consent.noticeText}
        noticeLocale={consent.noticeLocale}
        organisationName={consent.organisationName}
        isMinor={consent.isMinor}
        locale={locale}
        onDecide={decideConsent}
      />
    );
  }

  if (state === 'refused') {
    return <RefusedScreen locale={locale} events={consentEvents} />;
  }

  if (state === 'deciding' && matches) {
    return (
      <DuplicateCheck
        candidates={matches.candidates}
        hiddenCount={matches.hiddenCount}
        locale={locale}
        fieldLabels={Object.fromEntries(
          topLevel.map((field) => [field.key, t(field.label, locale, field.key)]),
        )}
        // Same person: the answers attach to the record that already exists
        // rather than creating a second one.
        onPick={(id) => void commit(data, id)}
        onNew={() => void commit(data, subjectId ?? null)}
      />
    );
  }

  if (state === 'done') {
    return <SavedScreen locale={locale} subjectName={subjectName} onAddAnother={startAnother} />;
  }

  // Deliberately not gated on the draft having been restored. Returning null
  // until then would leave a blank white screen through hydration, which on a
  // low-end phone over a slow connection is seconds of the worker wondering
  // whether the app is broken. The first question renders server-side; a
  // restored draft populates it a moment later.

  if (questions.length === 0 || !current) {
    return <p className="p-5 text-field-base text-slate-600">{m(locale, 'noFormsYet')}</p>;
  }

  const config = resolveFieldConfig(current);

  return (
    <div className="flex min-h-dvh flex-col">
      <Progress current={index + 1} total={questions.length} locale={locale} />

      <div className="flex flex-1 flex-col gap-6 px-5 py-6">
        <div>
          <h1 className="text-field-question font-semibold text-slate-900">
            {t(current.label, locale, current.key)}
            {current.isRequired ? (
              <span aria-hidden className="ml-1 text-deny-500">
                *
              </span>
            ) : null}
          </h1>
          {current.help ? (
            <p className="mt-2 text-field-sm text-slate-600">{t(current.help, locale)}</p>
          ) : null}
        </div>

        <QuestionInput
          key={current.key}
          field={current}
          config={config}
          value={data[current.key]}
          locale={locale}
          // Needed by a repeating section, to find its child questions, and by
          // the attachment types, which name the version when reserving an
          // upload so the server can check the question really takes a file.
          version={version}
          onChange={(value) => setAnswer(current, value)}
        />

        {error ? (
          <p role="alert" className="rounded-field bg-deny-50 p-4 text-field-sm font-medium text-deny-700">
            {error}
          </p>
        ) : null}

      </div>

      {/* Actions pinned to the bottom, within thumb reach on a large phone. */}
      <div className="sticky bottom-0 flex gap-3 border-t border-slate-200 bg-white px-5 py-4">
        {index > 0 ? (
          <button
            type="button"
            onClick={goBack}
            className="field-button w-auto shrink-0 border-2 border-slate-300 bg-white px-6 text-slate-800"
          >
            <ArrowLeft aria-hidden className="h-5 w-5" />
            {m(locale, 'back')}
          </button>
        ) : null}

        {isLast ? (
          <button
            type="button"
            onClick={save}
            disabled={state === 'saving' || state === 'checking'}
            className="field-button bg-affirm-500 text-white disabled:opacity-60"
          >
            {state === 'saving' || state === 'checking' ? (
              <Loader2 aria-hidden className="h-5 w-5 animate-spin" />
            ) : (
              <Check aria-hidden className="h-5 w-5" />
            )}
            {state === 'checking'
              ? m(locale, 'checkingForMatches')
              : state === 'saving'
                ? m(locale, 'saving')
                : m(locale, 'save')}
          </button>
        ) : (
          <button type="button" onClick={goNext} className="field-button bg-brand-600 text-white">
            {m(locale, 'next')}
            <ArrowRight aria-hidden className="h-5 w-5" />
          </button>
        )}
      </div>
    </div>
  );
}

function Progress({ current, total, locale }: { current: number; total: number; locale: string }) {
  return (
    <div className="px-5 pt-4">
      <div
        role="progressbar"
        aria-valuenow={current}
        aria-valuemin={1}
        aria-valuemax={total}
        aria-label={m(locale, 'questionOf', { current, total })}
        className="h-2 w-full overflow-hidden rounded-full bg-slate-200"
      >
        <div
          className="h-full rounded-full bg-brand-500 transition-all"
          style={{ width: `${(current / total) * 100}%` }}
        />
      </div>
      <p className="mt-2 text-field-sm text-slate-500">
        {m(locale, 'questionOf', { current, total })}
      </p>
    </div>
  );
}

/**
 * The confirmation screen.
 *
 * Full-screen and unambiguous. Uncertainty about whether something saved is the
 * most common cause of duplicate entries in field data collection — a worker
 * who is not sure will simply fill it in again.
 */
function SavedScreen({
  locale,
  subjectName,
  onAddAnother,
}: {
  locale: string;
  subjectName?: string | null;
  onAddAnother: () => void;
}) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-8 bg-affirm-50 px-5">
      <div className="flex h-28 w-28 items-center justify-center rounded-full bg-affirm-500">
        <Check aria-hidden className="h-16 w-16 text-white" strokeWidth={3} />
      </div>

      <p role="status" className="text-center text-2xl font-bold text-affirm-700">
        {subjectName ? m(locale, 'savedFor', { name: subjectName }) : m(locale, 'saved')}
      </p>

      <div className="flex w-full max-w-md flex-col gap-3">
        <button type="button" onClick={onAddAnother} className="field-button bg-brand-600 text-white">
          {m(locale, 'addAnother')}
        </button>
        <a href="/" className="field-button border-2 border-slate-300 bg-white text-slate-800">
          {m(locale, 'goHome')}
        </a>
      </div>
    </div>
  );
}


/**
 * Somebody said no.
 *
 * The refusal is still recorded — through `/api/consent`, since there is no
 * submission to carry it. "We asked and they declined" and "we never asked" are
 * different facts, and only the second is a compliance failure. Sent on mount
 * and not retried here: the endpoint is idempotent on `clientEventUuid`, so the
 * queue picks up anything that did not land.
 *
 * Two cases, and only one of them can be recorded.
 *
 * Where the person already exists — an encounter, or a registration for
 * somebody on file — the refusal is a fact about them and is written through
 * `/api/consent`, which needs no submission behind it. "We asked and they
 * declined" and "we never asked" are different facts, and until the events
 * carried a `subjectId` this filter matched nothing and neither was ever
 * recorded.
 *
 * Where a registration is refused before anybody is created, there is nothing
 * to attach to, and inventing a subject in order to record that they refused to
 * become one would be the opposite of honouring the refusal. The absence is the
 * record.
 */
function RefusedScreen({
  locale,
  events,
}: {
  locale: string;
  events: Record<string, unknown>[];
}) {
  useEffect(() => {
    const withSubject = events.filter((event) => event.subjectId);
    if (withSubject.length === 0) return;

    void fetch('/api/consent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: withSubject }),
      // A lapsed session redirects rather than returning a 401, and a followed
      // redirect answers 200 from the login page. Same trap as the send queue.
      redirect: 'manual',
    })
      .then((response) => {
        // Kept for the queue to retry unless the server actually took it. A
        // 409 means it already has these under the same ids, differently, and
        // retrying cannot help.
        if (!response.ok && response.status !== 409) queueConsentEvents(withSubject);
      })
      .catch(() => {
        /*
         * No signal. Parked rather than dropped: this is the whole record that
         * the organisation asked and was told no, and a worker in a village
         * with no bars is the ordinary case rather than the exception. It sends
         * on the same sweep the submission queue runs on.
         */
        queueConsentEvents(withSubject);
      });
  }, [events]);

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-5 text-center">
      <p className="text-field-question font-bold text-slate-900">{m(locale, 'consentNo')}</p>
      <p className="text-field-base text-slate-600">{m(locale, 'consentRefused')}</p>
      <a href="/" className="field-button mt-4 border-2 border-slate-300 bg-white text-slate-800">
        {m(locale, 'backToList')}
      </a>
    </div>
  );
}
