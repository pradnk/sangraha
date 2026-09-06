'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, Check, ShieldAlert, ShieldCheck, ShieldX } from 'lucide-react';
import type { ConsentRecord, MinorBasis } from '@sangraha/db';
import { t } from '@/lib/i18n';
import { m } from '@/lib/messages';
import { clearGuardianFlag } from '@/app/(field)/review/actions';

/**
 * The permission behind a record, for whoever is approving it.
 *
 * The review screen showed every answer and nothing about whether the person had
 * agreed to give them — so a supervisor approving the registration of a child
 * could not see that a child was involved, let alone whether a guardian had
 * agreed. The columns were all being written; nothing read them back.
 *
 * A supervisor can also resolve the guardian gap here, which is where
 * `pendingOverrides` always said the decision would land ("the decision lands in
 * the same queue as everything else they review"). Until now it only existed on
 * the admin Privacy screen, which a supervisor cannot reach.
 *
 * Ordered by how alarming it is: a child with no guardian first, because that is
 * the highest-penalty failure in the Act and the one thing here that a
 * supervisor must act on rather than merely read.
 */
export function ConsentRecordPanel({
  records,
  consentNeeded,
  locale,
}: {
  records: ConsentRecord[];
  /** False when no purpose on this form rests on anybody's permission. */
  consentNeeded: boolean;
  locale: string;
}) {
  const when = (date: Date) =>
    new Intl.DateTimeFormat(`${locale}-IN`, { dateStyle: 'medium', timeStyle: 'short' }).format(
      date,
    );

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-field-base font-bold text-slate-900">
        {m(locale, 'consentRecordTitle')}
      </h2>

      {records.length === 0 ? (
        <p
          className={`flex items-start gap-2 rounded-field p-4 text-field-sm ${
            consentNeeded ? 'bg-deny-50 text-deny-700' : 'bg-slate-50 text-slate-600'
          }`}
        >
          {consentNeeded ? (
            <AlertCircle aria-hidden className="mt-0.5 h-5 w-5 shrink-0" />
          ) : null}
          {/*
           * Two very different facts, and the difference is the whole point.
           * "Nobody asked" on a form that needs consent is a problem for the
           * supervisor to chase; on a form resting on a legitimate use it is
           * correct, and flagging it would teach them to ignore the flag.
           */}
          {m(locale, consentNeeded ? 'consentRecordNone' : 'consentRecordNotNeeded')}
        </p>
      ) : null}

      {records.map((record) => (
        <ConsentRow key={record.eventId} record={record} locale={locale} when={when} />
      ))}
    </section>
  );
}

const BASIS_KEY: Record<MinorBasis, 'consentBasisDob' | 'consentBasisAgeField' | 'consentBasisWorkerDeclared' | 'consentBasisUnknown'> = {
  dob: 'consentBasisDob',
  age_field: 'consentBasisAgeField',
  worker_declared: 'consentBasisWorkerDeclared',
  unknown: 'consentBasisUnknown',
};

function ConsentRow({
  record,
  locale,
  when,
}: {
  record: ConsentRecord;
  locale: string;
  when: (date: Date) => string;
}) {
  const agreed = record.action === 'given' || record.action === 'asserted';
  const needsDecision = record.pendingOverride;

  const actionLabel = m(
    locale,
    record.action === 'given'
      ? 'consentGiven'
      : record.action === 'withdrawn'
        ? 'consentWithdrawn'
        : record.action === 'refused'
          ? 'consentRefusedLabel'
          : 'consentAsserted',
  );

  return (
    <div
      data-consent-purpose={record.purposeCode}
      className={`flex flex-col gap-2 rounded-field border-2 p-4 ${
        needsDecision
          ? 'border-deny-400 bg-deny-50'
          : agreed
            ? 'border-slate-200 bg-white'
            : 'border-amber-300 bg-amber-50'
      }`}
    >
      <div className="flex items-start gap-2">
        {needsDecision ? (
          <ShieldAlert aria-hidden className="mt-0.5 h-5 w-5 shrink-0 text-deny-600" />
        ) : agreed ? (
          <ShieldCheck aria-hidden className="mt-0.5 h-5 w-5 shrink-0 text-affirm-600" />
        ) : (
          <ShieldX aria-hidden className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-field-base font-semibold text-slate-900">
            {t(record.purposeName, locale, record.purposeCode)}
          </p>
          <p className="text-field-sm text-slate-700">
            {actionLabel} {m(locale, 'consentOn', { date: when(record.occurredAt) })}
          </p>
        </div>
      </div>

      {/* Was it a child, and how do we know — "her recorded date of birth" and
          "the worker said so" are different answers to the same question. */}
      {record.subjectIsMinor ? (
        <p className="text-field-sm text-slate-700">
          {m(locale, 'consentIsChild')}
          {record.minorBasis ? ` — ${m(locale, BASIS_KEY[record.minorBasis])}` : ''}
        </p>
      ) : null}

      {record.subjectIsMinor ? (
        <p
          className={`text-field-sm font-medium ${
            record.guardianName ? 'text-slate-800' : 'text-deny-700'
          }`}
        >
          {record.guardianName
            ? m(locale, 'consentGuardianWas', {
                name: record.guardianRelationship
                  ? `${record.guardianName} (${record.guardianRelationship})`
                  : record.guardianName,
              })
            : m(locale, 'consentGuardianNone')}
        </p>
      ) : null}

      {/* The only objective signal of attestation quality that exists, given
          there is no signature on the doorstep. */}
      {record.noticeVersionNumber !== null && record.noticeSecondsShown !== null ? (
        <p className="text-field-sm text-slate-500">
          {m(locale, 'consentNoticeShown', {
            version: record.noticeVersionNumber,
            seconds: record.noticeSecondsShown,
          })}
        </p>
      ) : null}
      {record.noticeReadAloud === false ? (
        <p className="text-field-sm text-amber-800">{m(locale, 'consentNoticeNotRead')}</p>
      ) : null}
      {record.noticeMismatch ? (
        <p className="text-field-sm text-deny-700">{m(locale, 'consentNoticeMismatch')}</p>
      ) : null}

      {needsDecision ? (
        <GuardianGap eventId={record.eventId} locale={locale} />
      ) : record.overrideAt ? (
        /*
         * Says a supervisor accepted it and when. Deliberately still visible
         * after the decision: an override is an accepted exception, not a
         * cleared one, and a record that looked clean afterwards would be a
         * permission rather than an exception.
         */
        <p className="flex items-start gap-2 text-field-sm text-slate-600">
          <Check aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {m(locale, 'consentOverrideDone', { date: when(record.overrideAt) })}
            {record.overrideReason ? ` — “${record.overrideReason}”` : ''}
          </span>
        </p>
      ) : null}
    </div>
  );
}

/**
 * A child recorded with no guardian, and the supervisor's decision on it.
 *
 * Never sets `guardian_verified`: approving says a supervisor accepted the gap
 * and gave a reason, not that a guardian appeared. A reason is required and has
 * a minimum length, because "ok" is not a reason and a picklist would have
 * produced "Other" almost every time.
 */
function GuardianGap({ eventId, locale }: { eventId: string; locale: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    if (reason.trim().length < 10) {
      setError(m(locale, 'consentOverrideTooShort'));
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await clearGuardianFlag(eventId, reason.trim());
      if (!result.ok) {
        setError(result.error ?? m(locale, 'consentOverrideTooShort'));
        return;
      }
      router.refresh();
    });
  };

  return (
    <div className="flex flex-col gap-2 border-t-2 border-deny-200 pt-3">
      <p className="text-field-sm font-semibold text-deny-800">
        {m(locale, 'consentNeedsYourDecision')}
      </p>
      <label className="text-field-sm text-slate-700" htmlFor={`gap-${eventId}`}>
        {m(locale, 'consentOverrideReasonLabel')}
      </label>
      <textarea
        id={`gap-${eventId}`}
        value={reason}
        onChange={(event) => {
          setError(null);
          setReason(event.target.value);
        }}
        rows={3}
        className="field-control py-2"
      />
      {error ? (
        <p role="alert" className="text-field-sm font-medium text-deny-700">
          {error}
        </p>
      ) : null}
      <button
        type="button"
        disabled={pending}
        onClick={submit}
        className="field-button bg-brand-600 text-white disabled:opacity-60"
      >
        <Check aria-hidden className="h-5 w-5" />
        {m(locale, 'consentOverrideSave')}
      </button>
    </div>
  );
}
