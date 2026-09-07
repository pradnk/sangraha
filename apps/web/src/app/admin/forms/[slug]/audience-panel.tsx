'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Users } from 'lucide-react';
import { setFormAudienceAction } from './actions';

type Audience = 'everyone' | 'supervisors' | 'admins';

export interface AudienceCandidate {
  id: string;
  fullName: string;
  username: string;
  role: 'field_worker' | 'supervisor';
}

/**
 * Each option carries its own approver, so "nobody can approve this" is not a
 * state the screen can produce. The hint says who that is, because it is the
 * consequence an admin would otherwise discover from a queue that stopped
 * filling up.
 */
const CHOICES: { value: Audience; label: string; hint: string }[] = [
  {
    value: 'everyone',
    label: 'Everyone in the organisation',
    hint: 'Anyone signed in can fill it in. Supervisors approve.',
  },
  {
    value: 'supervisors',
    label: 'Supervisors, plus the field workers I choose',
    hint: 'Supervisors can always use and approve it, including anyone who joins later.',
  },
  {
    value: 'admins',
    label: 'Organisation admins, plus the people I choose',
    hint: 'Only admins approve. Supervisors will not see these records at all.',
  },
];

/**
 * Who may use this form.
 *
 * A form setting rather than a draft one, so it takes effect the moment it is
 * chosen — see `setFormAudienceAction`. Sits beside "Who is it about?" and works
 * the same way: no Save button, each change saved as it is made.
 *
 * **Every option carries its own approver.** That is the design rather than a
 * detail of the copy: an earlier version let an admin compose an audience with
 * no reviewer in it and then explained the consequence in a warning. Building
 * the approver into each choice means the warning has nothing left to warn
 * about, and each option can simply say who approves.
 */
export function AudiencePanel({
  slug,
  audience,
  selectedUserIds,
  candidates,
}: {
  slug: string;
  audience: Audience;
  selectedUserIds: string[];
  candidates: AudienceCandidate[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  /*
   * Held locally so ticking several people in a row feels immediate. The server
   * is still the authority — every change is saved as it is made, and
   * `router.refresh()` reconciles.
   */
  const [choice, setChoice] = useState<Audience>(audience);
  const [chosen, setChosen] = useState<string[]>(selectedUserIds);

  const save = (next: Audience, ids: string[]) =>
    startTransition(async () => {
      const result = await setFormAudienceAction(slug, next, ids);
      setError(result.error ?? null);
      if (!result.error) router.refresh();
    });

  const pickAudience = (next: Audience) => {
    setChoice(next);
    save(next, chosen);
  };

  const toggle = (userId: string) => {
    const next = chosen.includes(userId)
      ? chosen.filter((id) => id !== userId)
      : [...chosen, userId];
    setChosen(next);
    save(choice, next);
  };

  /*
   * Who is worth offering depends on the tier. On a supervisors form every
   * supervisor is already in, so listing them would imply a choice that does
   * not exist; on an admins form both roles are addable, because neither is
   * included by default.
   */
  const pickable =
    choice === 'supervisors'
      ? candidates.filter((person) => person.role === 'field_worker')
      : candidates;

  /*
   * Nobody added is not an error here. On a supervisors form it means
   * "supervisors only" — a monthly block report — and on an admins form it
   * means "admins only". Both are real things to want, which is why publish no
   * longer refuses them.
   */
  const restricted = choice !== 'everyone';

  return (
    <section
      className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4"
    >
      <div className="flex items-start gap-2">
        <Users aria-hidden className="mt-0.5 h-5 w-5 shrink-0 text-brand-600" />
        <div>
          <h2 className="font-semibold">Who can use this form?</h2>
          <p className="text-sm text-slate-700">
            Organisation admins can always use and approve it, so every form has somebody who can
            check what it collects.
          </p>
        </div>
      </div>

      {error ? (
        <p role="alert" className="rounded bg-deny-50 p-3 text-sm text-deny-700">
          {error}
        </p>
      ) : null}

      <div className="flex flex-col gap-1">
        {CHOICES.map((option) => (
          <label
            key={option.value}
            className="flex items-start gap-2.5 rounded px-1 py-1.5 hover:bg-slate-50"
          >
            <input
              type="radio"
              name="audience"
              value={option.value}
              checked={choice === option.value}
              disabled={pending}
              onChange={() => pickAudience(option.value)}
              className="mt-1"
            />
            <span>
              <span className="font-medium">{option.label}</span>
              <span className="block text-sm text-slate-600">{option.hint}</span>
            </span>
          </label>
        ))}
      </div>

      {restricted ? (
        <div className="ml-6">
          {pickable.length === 0 ? (
            <p className="text-sm text-slate-700">
              There is nobody else to add — the people above already cover it.
            </p>
          ) : (
            <>
              <div className="max-h-48 max-w-md overflow-y-auto rounded border border-slate-300 bg-white">
                {pickable.map((person) => (
                  <label
                    key={person.id}
                    className="flex items-center gap-2 border-b border-slate-100 px-3 py-2 text-sm last:border-b-0 hover:bg-slate-50"
                  >
                    <input
                      type="checkbox"
                      checked={chosen.includes(person.id)}
                      disabled={pending}
                      onChange={() => toggle(person.id)}
                    />
                    <span className="flex-1">{person.fullName}</span>
                    <span className="text-slate-500">
                      {person.role === 'supervisor' ? 'supervisor' : 'field worker'}
                    </span>
                  </label>
                ))}
              </div>

              {/* Said plainly, because an empty list looks like an unfinished
                  job and is often the intended answer. */}
              <p className="mt-2 text-sm text-slate-600">
                {chosen.length === 0
                  ? choice === 'supervisors'
                    ? 'Nobody added, so this is a supervisors-only form.'
                    : 'Nobody added, so this is an admins-only form.'
                  : `${chosen.length} added.`}
              </p>
            </>
          )}
        </div>
      ) : null}

    </section>
  );
}
