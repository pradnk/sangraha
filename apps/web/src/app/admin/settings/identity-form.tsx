'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, ShieldCheck } from 'lucide-react';
// Type-only: a value import from `@sangraha/db` would pull postgres and argon2
// into the browser bundle. `missing` is computed on the server and passed down.
import type { OrgIdentity } from '@sangraha/db';
import { updateOrgIdentityAction, type IdentityState } from './identity-actions';

/**
 * Who this organisation is, in law.
 *
 * Under the Digital Personal Data Protection Act the NGO — not Sangraha — is
 * the Data Fiduciary. Every obligation a beneficiary can enforce runs against
 * them, so a privacy notice has to be able to name the organisation collecting
 * the data and say how to complain to it.
 *
 * Written in the terms an NGO administrator actually uses rather than the
 * Act's. "Who people complain to" is the same field as a Grievance Officer and
 * is far more likely to be filled in correctly.
 */
export function IdentityForm({
  identity,
  missingFields,
}: {
  identity: OrgIdentity;
  /** From `missingForNotice`, evaluated on the server — see the import note. */
  missingFields: (keyof OrgIdentity)[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<IdentityState>({});

  const run = (patch: Parameters<typeof updateOrgIdentityAction>[0]) =>
    startTransition(async () => {
      setMessage(await updateOrgIdentityAction(patch));
      router.refresh();
    });

  const missing = new Set<string>(missingFields);

  return (
    <section
      id="legal"
      className="flex flex-col gap-4 scroll-mt-4 rounded-lg border border-slate-200 bg-white p-5"
    >
      <div>
        <h2 className="font-semibold">Legal details and privacy contact</h2>
        <p className="mt-1 text-xs text-slate-500">
          The law makes your organisation responsible for the personal information you collect. These
          details go into the privacy notice your team reads out to people, so they need to be the
          real ones.
        </p>
      </div>

      {message.error ? (
        <p role="alert" className="flex items-start gap-2 rounded-lg bg-deny-50 p-3 text-sm text-deny-700">
          <AlertCircle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          {message.error}
        </p>
      ) : null}

      {missing.size === 0 ? (
        <p className="flex items-start gap-2 rounded-lg bg-affirm-50 p-3 text-sm text-affirm-700">
          <ShieldCheck aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          You have everything needed to publish a privacy notice.
        </p>
      ) : (
        <p className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
          <AlertCircle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          {/* Named rather than counted: "3 fields missing" makes somebody hunt. */}
          Still needed before you can publish a privacy notice — {describe(missing)}.
        </p>
      )}

      <Field
        label="Registered name"
        hint="The name on your registration certificate, if it differs from the name your team uses."
        value={identity.legalName}
        missing={missing.has('legalName')}
        disabled={pending}
        onSave={(legalName) => run({ legalName })}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Kind of organisation"
          hint="Trust, society, Section 8 company."
          value={identity.entityType}
          disabled={pending}
          onSave={(entityType) => run({ entityType })}
        />
        <Field
          label="Registration number"
          value={identity.registrationNumber}
          disabled={pending}
          onSave={(registrationNumber) => run({ registrationNumber })}
        />
      </div>

      <Field
        label="Registered address"
        value={identity.registeredAddress}
        missing={missing.has('registeredAddress')}
        disabled={pending}
        multiline
        onSave={(registeredAddress) => run({ registeredAddress })}
      />

      <div className="border-t border-slate-100 pt-4">
        <h3 className="text-sm font-semibold">Who people complain to</h3>
        <p className="mt-1 text-xs text-slate-500">
          Anyone whose information you hold can ask to see it, correct it, or have it deleted — and
          can complain if they are unhappy. This is the person who handles that. A phone number is
          enough; an email address is not required.
        </p>

        <div className="mt-3 flex flex-col gap-4">
          <Field
            label="Name"
            value={identity.grievanceOfficerName}
            missing={missing.has('grievanceOfficerName')}
            disabled={pending}
            onSave={(grievanceOfficerName) => run({ grievanceOfficerName })}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Phone"
              value={identity.grievanceOfficerPhone}
              missing={missing.has('grievanceOfficerEmail')}
              disabled={pending}
              onSave={(grievanceOfficerPhone) => run({ grievanceOfficerPhone })}
            />
            <Field
              label="Email"
              value={identity.grievanceOfficerEmail}
              missing={missing.has('grievanceOfficerEmail')}
              disabled={pending}
              onSave={(grievanceOfficerEmail) => run({ grievanceOfficerEmail })}
            />
          </div>
        </div>
      </div>

      <div className="border-t border-slate-100 pt-4">
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={identity.dataRegion === 'IN'}
            disabled={pending}
            onChange={(event) => run({ dataRegion: event.target.checked ? 'IN' : 'ANY' })}
            className="mt-1 h-4 w-4"
          />
          <span>
            <span className="text-sm font-medium">Keep our data in India</span>
            <span className="mt-0.5 block text-xs text-slate-500">
              {/* On by default. Government scheme agreements routinely require
                  it even though the Act itself does not. */}
              Government programme agreements often require this. Leave it on unless you know you do
              not need it.
            </span>
          </span>
        </label>
      </div>
    </section>
  );
}

const NAMES: Record<string, string> = {
  legalName: 'registered name',
  registeredAddress: 'registered address',
  grievanceOfficerName: 'the name of who people complain to',
  grievanceOfficerEmail: 'a phone number or email for them',
  dpoName: 'a Data Protection Officer',
};

function describe(missing: Set<string>): string {
  const parts = [...missing].map((key) => NAMES[key] ?? key);
  if (parts.length === 1) return parts[0]!;
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

function Field({
  label,
  hint,
  value,
  missing,
  disabled,
  multiline,
  onSave,
}: {
  label: string;
  hint?: string;
  value: string | null;
  missing?: boolean;
  disabled: boolean;
  multiline?: boolean;
  onSave: (value: string) => void;
}) {
  /*
   * Saves on blur, like the rest of the admin console — no Save button to
   * forget, and `key` on the current value so a server refresh is reflected.
   *
   * `key` is deliberately not in `shared`. React reads it off the JSX element
   * itself, never out of a spread object, so spreading it both fails to
   * remount the input and logs a warning on every render.
   */
  const remountOnSave = value ?? '';
  const shared = {
    defaultValue: value ?? '',
    disabled,
    onBlur: (event: { target: { value: string } }) => {
      if (event.target.value.trim() !== (value ?? '')) onSave(event.target.value);
    },
    className: `w-full rounded border px-3 py-2 text-sm disabled:bg-slate-50 ${
      missing ? 'border-amber-400 bg-amber-50/40' : 'border-slate-300'
    }`,
  };

  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm font-medium">{label}</span>
      {hint ? <span className="text-xs text-slate-500">{hint}</span> : null}
      {multiline ? (
        <textarea key={remountOnSave} rows={2} {...shared} />
      ) : (
        <input key={remountOnSave} {...shared} />
      )}
    </label>
  );
}
