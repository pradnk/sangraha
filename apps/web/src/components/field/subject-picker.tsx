'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Loader2, Search, User } from 'lucide-react';
import { t } from '@/lib/i18n';
import { m } from '@/lib/messages';

/**
 * "Find a person."
 *
 * One component behind three screens — `/find`, choosing who an encounter is
 * for, and the `subject_ref` question — so that search behaves identically
 * wherever a worker meets it. Three separate search boxes with three slightly
 * different behaviours is three things to learn.
 *
 * Search runs against the ordinary request connection, so what comes back is
 * scoped to the worker's own places by Row-Level Security.
 */

export interface PickerSubject {
  id: string;
  displayName: string;
  externalId: string | null;
  locationName: Record<string, string> | null;
  subjectTypeName: Record<string, string> | null;
  registeredAt?: string;
  registeredByName?: string | null;
  /**
   * The answers that tell this person from a namesake.
   *
   * A list of bare names is not something anybody can choose from when two
   * people share one — which they do, constantly, in a village register.
   */
  details?: { key: string; label: string; value: string }[];
}

export interface SubjectPickerProps {
  locale: string;
  /** Restricts results to one kind of subject — set when filling an encounter. */
  subjectTypeId?: string | null;
  /** Left out of the results, so a record cannot be offered as its own match. */
  excludeId?: string | null;
  onPick: (subject: PickerSubject) => void;
  autoFocus?: boolean;
}

export function SubjectPicker({
  locale,
  subjectTypeId,
  excludeId,
  onPick,
  autoFocus = false,
}: SubjectPickerProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PickerSubject[] | null>(null);
  const [searching, setSearching] = useState(false);

  // Tracks the most recent request so a slow early response cannot overwrite a
  // faster later one — on a patchy connection that shows results for a name
  // the worker has already finished retyping.
  const latest = useRef(0);

  useEffect(() => {
    const token = ++latest.current;
    const trimmed = query.trim();

    // Typing is slow on a phone keyboard, and every keystroke is a request over
    // a connection that may be 2G. Wait for a pause.
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const params = new URLSearchParams();
        if (trimmed) params.set('q', trimmed);
        if (subjectTypeId) params.set('type', subjectTypeId);

        const response = await fetch(`/api/subjects/search?${params}`);
        const body = (await response.json()) as { results: PickerSubject[] };
        const found = excludeId
          ? body.results.filter((subject) => subject.id !== excludeId)
          : body.results;
        if (token === latest.current) setResults(found);
      } catch {
        if (token === latest.current) setResults([]);
      } finally {
        if (token === latest.current) setSearching(false);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [query, subjectTypeId, excludeId]);

  return (
    <div className="flex flex-col gap-4">
      <div className="relative">
        <Search
          aria-hidden
          className="pointer-events-none absolute left-4 top-1/2 h-6 w-6 -translate-y-1/2 text-slate-400"
        />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={m(locale, 'searchByName')}
          aria-label={m(locale, 'searchByName')}
          autoFocus={autoFocus}
          // The shared control surface, with room made for the search icon.
          className="field-control pl-14"
        />
        {searching ? (
          <Loader2
            aria-hidden
            className="absolute right-4 top-1/2 h-5 w-5 -translate-y-1/2 animate-spin text-slate-400"
          />
        ) : null}
      </div>

      {results === null ? (
        <p className="px-1 text-field-sm text-slate-500">{m(locale, 'searching')}</p>
      ) : results.length === 0 ? (
        <p className="rounded-field bg-slate-100 p-5 text-field-base text-slate-700">
          {/* Two different dead ends, and the difference matters: one means try
              another spelling, the other means go and register somebody. */}
          {query.trim() ? m(locale, 'noOneFound') : m(locale, 'noOneRegisteredYet')}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {results.map((subject) => (
            <li key={subject.id}>
              <button
                type="button"
                onClick={() => onPick(subject)}
                className="flex min-h-tap w-full items-start gap-4 rounded-field border-2 border-slate-300 bg-white p-4 text-left active:border-brand-500 active:bg-brand-50"
              >
                <User aria-hidden className="mt-0.5 h-7 w-7 shrink-0 text-brand-600" />
                <span className="min-w-0 flex-1">
                  <span className="block text-field-base font-semibold text-slate-900">
                    {subject.displayName}
                  </span>

                  {/* What actually distinguishes them. Without this, two people
                      called Test1 produce two identical rows. */}
                  {subject.details?.length ? (
                    <span className="mt-0.5 block">
                      {subject.details.map((detail) => (
                        <span key={detail.key} className="block text-field-sm text-slate-700">
                          <span className="text-slate-500">{detail.label}:</span> {detail.value}
                        </span>
                      ))}
                    </span>
                  ) : null}

                  <span className="mt-0.5 block text-field-sm text-slate-500">
                    {[
                      t(subject.subjectTypeName, locale),
                      t(subject.locationName, locale),
                      subject.externalId,
                      subject.registeredAt
                        ? m(locale, 'registeredOn', {
                            date: formatDate(subject.registeredAt, locale),
                          })
                        : '',
                      subject.registeredByName
                        ? m(locale, 'registeredBySomeone', { name: subject.registeredByName })
                        : '',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
                <ArrowRight aria-hidden className="mt-1 h-6 w-6 shrink-0 text-slate-400" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
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
