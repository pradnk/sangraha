'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, ImageUp, Info, Trash2 } from 'lucide-react';
import { OrgBrand, type OrgIdentity } from '@/components/brand/org-brand';
import { describeSize, prepareLogo } from '@/lib/image';
import { removeLogoAction, uploadLogoAction, type LogoState } from './logo-actions';

/**
 * Logo upload.
 *
 * Shows the mark at header size rather than as a large preview — the question
 * an administrator is actually asking is "will this look right in the app", and
 * a 400px preview does not answer it.
 *
 * The file is resized in the browser before it is sent. Without that, picking an
 * ordinary print-resolution logo produced "Body exceeded 1 MB limit" from the
 * framework, thrown before any of our own validation could give a useful answer.
 */
const PREPARE_ERRORS: Record<string, string> = {
  not_an_image: 'That file is not an image. Choose a PNG, JPG, WebP or SVG file.',
  unreadable:
    'That image could not be read. It may be damaged, or an SVG that refers to fonts or images stored elsewhere.',
  still_too_large:
    'That image could not be made small enough. Try one without a photograph in it — a logo should be a few shapes and some text.',
};

export function LogoSection({ org }: { org: OrgIdentity }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<'idle' | 'preparing' | 'uploading'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const busy = pending || status !== 'idle';

  async function handleFile(file: File) {
    setError(null);
    setNote(null);
    setStatus('preparing');

    const prepared = await prepareLogo(file);
    if (!prepared.ok) {
      setStatus('idle');
      setError(PREPARE_ERRORS[prepared.reason] ?? 'That image could not be used.');
      return;
    }

    if (prepared.wasResized) {
      setNote(
        `Resized from ${describeSize(file.size)} to ${describeSize(prepared.file.size)} so it loads quickly on a phone.`,
      );
    }

    setStatus('uploading');

    // Called directly rather than through `useActionState`, so a failure from
    // the framework itself — a body limit, a dropped connection — can be caught
    // and reported instead of surfacing as an unhandled error.
    startTransition(async () => {
      try {
        const formData = new FormData();
        formData.set('logo', prepared.file);
        const result: LogoState = await uploadLogoAction(formData);
        if (result.error) setError(result.error);
        else router.refresh();
      } catch {
        setError('The upload did not complete. Please check your connection and try again.');
      } finally {
        setStatus('idle');
        if (inputRef.current) inputRef.current.value = '';
      }
    });
  }

  return (
    <section
      id="logo"
      className="flex flex-col gap-4 scroll-mt-4 rounded-lg border border-slate-200 bg-white p-5"
    >
      <div>
        <h2 className="font-semibold">Your logo</h2>
        <p className="mt-1 text-xs text-slate-500">
          Shown to your team at the top of every screen, and on the sign-in page. Without one, your
          organisation&rsquo;s name is shown instead — which looks perfectly good, so this is
          optional.
        </p>
      </div>

      {error ? (
        <p role="alert" className="flex items-start gap-2 rounded-lg bg-deny-50 p-3 text-deny-700">
          <AlertCircle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          {error}
        </p>
      ) : null}

      {note ? (
        <p className="flex items-start gap-2 rounded-lg bg-brand-50 p-3 text-brand-900">
          <Info aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          {note}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-4">
        <span className="text-xs uppercase tracking-wide text-slate-500">In the header</span>
        <span className="flex items-center rounded-lg border border-slate-200 bg-slate-50 px-4 py-2">
          <OrgBrand org={org} size="md" />
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label
          className={`inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 ${
            busy ? 'opacity-50' : 'cursor-pointer hover:bg-slate-50'
          }`}
        >
          <ImageUp aria-hidden className="h-4 w-4" />
          {org.logoStamp ? 'Replace logo' : 'Choose an image'}
          <input
            ref={inputRef}
            type="file"
            // SVG is accepted here and rasterised in the browser; only the
            // resulting pixels are stored, never the SVG document.
            accept="image/png,image/jpeg,image/webp,image/svg+xml"
            disabled={busy}
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void handleFile(file);
            }}
          />
        </label>

        {status === 'preparing' ? <span className="text-slate-500">Resizing…</span> : null}
        {status === 'uploading' ? <span className="text-slate-500">Uploading…</span> : null}

        {org.logoStamp ? (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              startTransition(async () => {
                await removeLogoAction();
                setNote(null);
                setError(null);
                router.refresh();
              })
            }
            className="inline-flex items-center gap-1.5 rounded-lg border border-deny-300 px-3 py-2 text-deny-700 hover:bg-deny-50 disabled:opacity-50"
          >
            <Trash2 aria-hidden className="h-4 w-4" />
            Remove
          </button>
        ) : null}
      </div>

      <p className="text-xs text-slate-500">
        Any image will do — large files are resized automatically. A wide logo works better than a
        tall one, since it sits in a header bar.
      </p>
    </section>
  );
}
