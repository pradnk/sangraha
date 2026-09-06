'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, Plus, Trash2 } from 'lucide-react';
import type { OrgSettings } from '@sangraha/db';
import { localise, pruneBlank, toSnakeCase } from '@sangraha/form-engine';
import { LANGUAGE_NAMES, UI_LOCALES } from '@/lib/i18n';
import { updateOrgSettingsAction, type PlacesState } from '../places/actions';

/**
 * Organisation settings.
 *
 * Three things an NGO genuinely needs to set for itself: what it is called, what
 * languages its staff read, and what it calls the levels of its geography.
 *
 * The slug is shown but not editable — it names the analytics schema and the
 * login URL, so changing it would orphan every generated view.
 */
export function SettingsForm({ settings, locale }: { settings: OrgSettings; locale: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<PlacesState>({});
  const [levels, setLevels] = useState(settings.locationLevels);
  const [newLevel, setNewLevel] = useState('');

  const run = (patch: Parameters<typeof updateOrgSettingsAction>[0]) =>
    startTransition(async () => {
      setMessage(await updateOrgSettingsAction(patch));
      router.refresh();
    });

  const enabled = new Set(settings.enabledLocales);

  const saveLevels = (next: typeof levels) => {
    setLevels(next);
    run({ locationLevels: next });
  };

  return (
    <div className="flex flex-col gap-6">
      {message.error ? (
        <p role="alert" className="flex items-start gap-2 rounded-lg bg-deny-50 p-3 text-deny-700">
          <AlertCircle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          {message.error}
        </p>
      ) : null}

      <section className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-5">
        <h2 className="font-semibold">Name</h2>
        <input
          defaultValue={settings.name}
          maxLength={200}
          onBlur={(event) => event.target.value !== settings.name && run({ name: event.target.value })}
          className="w-full max-w-md rounded border border-slate-300 px-3 py-2"
        />
        <p className="text-xs text-slate-500">
          Shown on the sign-in screen. Your sign-in address stays{' '}
          <code className="font-mono">{settings.slug}</code> — it names your reporting tables, so it
          cannot be changed.
        </p>
      </section>

      {/* The setup guide and the form builder both send people straight here,
          because this is the one setting worth changing before writing any
          questions — see the note in `admin/setup/page.tsx`. */}
      <section
        id="languages"
        className="flex flex-col gap-3 scroll-mt-4 rounded-lg border border-slate-200 bg-white p-5"
      >
        <h2 className="font-semibold">Languages</h2>
        <p className="text-xs text-slate-500">
          Which languages your staff can choose. Only languages the app itself is translated into
          are listed — offering one it is not would show a worker English while claiming otherwise.
        </p>
        <div className="flex flex-col gap-2">
          {UI_LOCALES.map((loc) => (
            <label key={loc} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={enabled.has(loc)}
                disabled={pending || (enabled.has(loc) && enabled.size === 1)}
                onChange={(event) =>
                  run({
                    enabledLocales: event.target.checked
                      ? [...enabled, loc]
                      : [...enabled].filter((l) => l !== loc),
                  })
                }
              />
              <span>{LANGUAGE_NAMES[loc]}</span>
              {enabled.has(loc) && enabled.size === 1 ? (
                <span className="text-xs text-slate-500">— at least one is needed</span>
              ) : null}
            </label>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-5">
        <h2 className="font-semibold">Levels of place</h2>
        <p className="text-xs text-slate-500">
          What you call each level of your geography, outermost first. An education programme might
          use District → Block → School; a health one District → Block → Village.
        </p>

        {levels.length === 0 ? (
          <p className="rounded bg-slate-50 p-3 text-slate-500">
            None set yet. Places will just be numbered levels until you name them.
          </p>
        ) : (
          <ol className="flex flex-col gap-2">
            {levels.map((level, index) => (
              <li key={level.key} className="flex items-center gap-2">
                <span className="w-5 text-right text-xs tabular-nums text-slate-400">
                  {index + 1}
                </span>
                <input
                  defaultValue={localise(level.label, locale, level.key)}
                  onBlur={(event) =>
                    saveLevels(
                      levels.map((l, i) =>
                        i === index
                          ? { ...l, label: pruneBlank({ ...l.label, [locale]: event.target.value }) }
                          : l,
                      ),
                    )
                  }
                  className="w-full max-w-xs rounded border border-slate-300 px-2 py-1.5"
                />
                {/* Removing a level that places already sit at would leave them
                    unlabelled, so only the deepest is removable. */}
                {index === levels.length - 1 ? (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => saveLevels(levels.slice(0, -1))}
                    aria-label="Remove this level"
                    className="rounded border border-deny-300 p-1.5 text-deny-700"
                  >
                    <Trash2 aria-hidden className="h-4 w-4" />
                  </button>
                ) : null}
              </li>
            ))}
          </ol>
        )}

        <form
          onSubmit={(event) => {
            event.preventDefault();
            const label = newLevel.trim();
            if (!label) return;
            saveLevels([...levels, { key: toSnakeCase(label) || `level_${levels.length + 1}`, label: { en: label } }]);
            setNewLevel('');
          }}
          className="flex gap-2 border-t border-slate-200 pt-3"
        >
          <input
            value={newLevel}
            onChange={(event) => setNewLevel(event.target.value)}
            placeholder="Add a level, e.g. Village"
            maxLength={40}
            className="min-w-0 flex-1 rounded border border-slate-300 px-2 py-1.5"
          />
          <button
            type="submit"
            disabled={pending || levels.length >= 6}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 font-medium text-white disabled:opacity-50"
          >
            <Plus aria-hidden className="h-4 w-4" />
            Add
          </button>
        </form>
      </section>
    </div>
  );
}
