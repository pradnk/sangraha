'use client';

import { useEffect, useRef, useState } from 'react';
import { Camera, CloudOff, FileText, ImageIcon, Loader2, Paperclip, X } from 'lucide-react';
import { getPending } from '@/lib/attachment-store';
import { captureAttachment } from '@/lib/attachment-upload';
import { describeSize, preparePhoto } from '@/lib/image';
import { m } from '@/lib/messages';
import type { QuestionInputProps } from './question-input';

/**
 * A photograph or a document.
 *
 * One component for both, because they differ only in what the file picker
 * accepts and how the result is previewed. The part that matters — reserve,
 * upload, fall back to the phone, show the worker which of those happened — is
 * identical, and having it twice would mean fixing the upload path twice.
 *
 * The answer is a uuid, never the bytes. Where those bytes are is the state
 * this component manages: in object storage, or still on the phone waiting for
 * a signal. Both look the same to the worker on purpose. "Saved" has to mean
 * saved, and a worker who is made to worry about upload state will stand in a
 * doorway waiting for a progress bar instead of moving on.
 */

type Status =
  | { kind: 'idle' }
  | { kind: 'working' }
  | { kind: 'queued' }
  | { kind: 'error'; message: string };

export function AttachmentAnswer({
  field,
  config,
  value,
  locale,
  version,
  onChange,
}: QuestionInputProps) {
  const isPhoto = field.dataType === 'photo';
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [filename, setFilename] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const attachmentId = typeof value === 'string' && value !== '' ? value : null;

  /*
   * Work out what to show for an answer that is already there — a restored
   * draft, or a question the worker has come back to.
   *
   * An id may name a file in storage or one still sitting in IndexedDB, and the
   * preview differs: the first is fetched through the download proxy, the
   * second is an object URL over local bytes. Asking the local store first is
   * what makes a draft restored with no signal still show its photo.
   */
  useEffect(() => {
    if (!attachmentId) {
      setPreviewUrl(null);
      setFilename(null);
      return;
    }

    let objectUrl: string | null = null;
    let cancelled = false;

    void getPending(attachmentId).then((pending) => {
      if (cancelled) return;

      if (pending) {
        setFilename(pending.filename);
        setStatus({ kind: 'queued' });
        if (pending.mimeType.startsWith('image/')) {
          objectUrl = URL.createObjectURL(pending.blob);
          setPreviewUrl(objectUrl);
        }
        return;
      }

      setStatus({ kind: 'idle' });
      if (isPhoto) setPreviewUrl(`/api/attachments/${attachmentId}`);
    });

    return () => {
      cancelled = true;
      // Object URLs are held by the document until revoked. A worker paging
      // through a roster of thirty photographs would otherwise keep every one
      // of them in memory.
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachmentId, isPhoto]);

  const choose = async (file: File) => {
    if (!version) return;
    setStatus({ kind: 'working' });

    let toSend = file;

    if (isPhoto) {
      /*
       * Shrunk before it goes anywhere. An 8 MP camera photo is several
       * megabytes; over 2G that is the difference between a submission that
       * lands and one that times out. The canvas round trip also strips EXIF,
       * which on most phones carries the GPS position the photo was taken at.
       */
      const prepared = await preparePhoto(
        file,
        Number(config.maxWidthPx ?? 1280),
        Number(config.compressionQuality ?? 0.7),
      );

      if (!prepared.ok) {
        setStatus({ kind: 'error', message: m(locale, 'attachmentWrongType') });
        return;
      }
      toSend = prepared.file;
    }

    const outcome = await captureAttachment(
      toSend,
      version.id,
      field.key,
      Number(config.maxSizeMb ?? 10) * 1024 * 1024,
    );

    if (outcome.state === 'rejected') {
      setStatus({
        kind: 'error',
        message:
          outcome.reason === 'too_large'
            ? m(locale, 'attachmentTooLarge', {
                size: describeSize(outcome.maxBytes ?? Number(config.maxSizeMb ?? 10) * 1024 * 1024),
              })
            : outcome.reason === 'unsupported_type'
              ? m(locale, 'attachmentWrongType')
              : m(locale, 'attachmentUnavailable'),
      });
      return;
    }

    setFilename(toSend.name);
    setStatus(outcome.state === 'queued' ? { kind: 'queued' } : { kind: 'idle' });
    onChange(outcome.id);
  };

  const clear = () => {
    setStatus({ kind: 'idle' });
    setPreviewUrl(null);
    setFilename(null);
    onChange(null);
    // A file input holds onto the last selection, so choosing the same photo
    // twice in a row would fire no change event at all.
    if (input.current) input.current.value = '';
  };

  const accepted = isPhoto
    ? 'image/*'
    : ((config.acceptedMimeTypes as string[] | undefined) ?? ['application/pdf', 'image/*']).join(',');

  return (
    <div className="flex flex-col gap-3">
      <input
        ref={input}
        type="file"
        accept={accepted}
        // `capture` opens the camera rather than the gallery. Only a hint — a
        // phone that ignores it shows the picker, which is a fine fallback.
        capture={isPhoto && config.preferCamera !== false ? 'environment' : undefined}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void choose(file);
        }}
      />

      {previewUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- the source is a
        // blob URL or an authorised proxy route, neither of which the Next image
        // optimiser can fetch.
        <img
          src={previewUrl}
          alt=""
          className="max-h-64 w-full rounded-field border-2 border-slate-200 bg-slate-50 object-contain"
        />
      ) : attachmentId ? (
        <p className="flex items-center gap-3 rounded-field border-2 border-slate-200 bg-white p-4 text-field-base text-slate-800">
          <FileText aria-hidden className="h-6 w-6 shrink-0 text-slate-500" />
          <span className="min-w-0 flex-1 truncate">{filename ?? m(locale, 'fileChoose')}</span>
        </p>
      ) : null}

      {status.kind === 'queued' ? (
        // Said plainly and without alarm. The file is safe; it is just not
        // uploaded, and there is nothing for the worker to do about it.
        <p className="flex items-start gap-2 rounded-field bg-slate-100 p-3 text-field-sm text-slate-700">
          <CloudOff aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          {m(locale, 'attachmentQueued')}
        </p>
      ) : null}

      {status.kind === 'error' ? (
        <p role="alert" className="rounded-field bg-deny-50 p-3 text-field-sm text-deny-700">
          {status.message}
        </p>
      ) : null}

      <button
        type="button"
        disabled={status.kind === 'working'}
        onClick={() => input.current?.click()}
        className={
          attachmentId
            ? 'field-button border-2 border-slate-300 bg-white text-slate-800 disabled:opacity-60'
            : 'field-button bg-brand-600 text-white disabled:opacity-60'
        }
      >
        {status.kind === 'working' ? (
          <Loader2 aria-hidden className="h-5 w-5 animate-spin" />
        ) : isPhoto ? (
          <Camera aria-hidden className="h-5 w-5" />
        ) : (
          <Paperclip aria-hidden className="h-5 w-5" />
        )}
        {status.kind === 'working'
          ? m(locale, 'attachmentUploading')
          : attachmentId
            ? m(locale, isPhoto ? 'photoRetake' : 'fileReplace')
            : m(locale, isPhoto ? 'photoTake' : 'fileChoose')}
      </button>

      {attachmentId ? (
        <button
          type="button"
          onClick={clear}
          className="field-button border-2 border-slate-300 bg-white text-slate-600"
        >
          <X aria-hidden className="h-5 w-5" />
          {m(locale, 'remove')}
        </button>
      ) : isPhoto && config.preferCamera !== false ? (
        // A second way in for the photo that was taken earlier, or on another
        // phone. `capture` sends the first button straight to the camera, which
        // would otherwise make the gallery unreachable.
        <button
          type="button"
          onClick={() => {
            if (!input.current) return;
            input.current.removeAttribute('capture');
            input.current.click();
            input.current.setAttribute('capture', 'environment');
          }}
          className="field-button border-2 border-slate-300 bg-white text-slate-700"
        >
          <ImageIcon aria-hidden className="h-5 w-5" />
          {m(locale, 'photoChoose')}
        </button>
      ) : null}
    </div>
  );
}
