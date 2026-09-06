'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, CloudOff, Eraser, Loader2, PenLine } from 'lucide-react';
import { getPending } from '@/lib/attachment-store';
import { captureAttachment } from '@/lib/attachment-upload';
import { t } from '@/lib/i18n';
import { m } from '@/lib/messages';
import type { QuestionInputProps } from './question-input';

/**
 * A signature or a thumb impression.
 *
 * Stored as an ordinary attachment — a PNG in object storage, the same as a
 * photograph — so nothing downstream needs to know it was drawn rather than
 * captured. The field type also emits a `_signed` boolean into the analytics
 * view, because what a compliance report needs is "did this person sign", not
 * the image.
 *
 * Drawn with pointer events rather than touch events: one code path covers a
 * finger, a stylus and a mouse, and it does not fight the browser over which of
 * those is happening. `touch-none` is what stops a drawn stroke from scrolling
 * the page instead — without it a signature on a phone is unusable.
 */

/** Big enough to be legible when printed on a consent form, small enough to send. */
const CANVAS_WIDTH = 900;
const CANVAS_HEIGHT = 320;

export function SignatureAnswer({ field, config, value, locale, version, onChange }: QuestionInputProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const hasInk = useRef(false);

  const [status, setStatus] = useState<'idle' | 'drawing' | 'saving' | 'queued' | 'error'>('idle');
  const [savedPreview, setSavedPreview] = useState<string | null>(null);

  const attachmentId = typeof value === 'string' && value !== '' ? value : null;
  const prompt = t(config.prompt as Record<string, string> | undefined, locale, '');

  // Show what was signed earlier, from the phone if it has not uploaded yet.
  useEffect(() => {
    if (!attachmentId) {
      setSavedPreview(null);
      return;
    }

    let objectUrl: string | null = null;
    let cancelled = false;

    void getPending(attachmentId).then((pending) => {
      if (cancelled) return;
      if (pending) {
        objectUrl = URL.createObjectURL(pending.blob);
        setSavedPreview(objectUrl);
        setStatus('queued');
      } else {
        setSavedPreview(`/api/attachments/${attachmentId}`);
      }
    });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachmentId]);

  /*
   * The backing store is fixed at 900x320 while the element is sized by CSS, so
   * a stroke has to be scaled from where the finger is to where the pixel is.
   * Drawing at the element's own size instead would make a signature captured
   * on a small phone visibly coarser than the same signature on a tablet.
   */
  const positionOf = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const element = event.currentTarget;
    const bounds = element.getBoundingClientRect();
    return {
      x: ((event.clientX - bounds.left) / bounds.width) * CANVAS_WIDTH,
      y: ((event.clientY - bounds.top) / bounds.height) * CANVAS_HEIGHT,
    };
  };

  const context = () => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx) return null;
    ctx.lineWidth = 3.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#0f172a';
    return ctx;
  };

  const start = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const ctx = context();
    if (!ctx) return;
    // Keeps the stroke following a finger that slides outside the box, rather
    // than ending it at the edge.
    event.currentTarget.setPointerCapture(event.pointerId);
    drawing.current = true;
    const { x, y } = positionOf(event);
    ctx.beginPath();
    ctx.moveTo(x, y);
    setStatus('drawing');
  };

  const move = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const ctx = context();
    if (!ctx) return;
    const { x, y } = positionOf(event);
    ctx.lineTo(x, y);
    ctx.stroke();
    hasInk.current = true;
  };

  const end = () => {
    drawing.current = false;
  };

  const clear = () => {
    const ctx = canvas.current?.getContext('2d');
    if (ctx && canvas.current) ctx.clearRect(0, 0, canvas.current.width, canvas.current.height);
    hasInk.current = false;
    setStatus('idle');
    setSavedPreview(null);
    onChange(null);
  };

  const commit = async () => {
    if (!canvas.current || !version || !hasInk.current) return;
    setStatus('saving');

    /*
     * Flattened onto white before it is encoded. A transparent PNG is correct
     * but looks like an empty box everywhere it might later be shown — a dark
     * mode viewer, a printed consent form, an exported PDF — and a signature
     * nobody can see is not evidence of anything.
     */
    const flat = document.createElement('canvas');
    flat.width = CANVAS_WIDTH;
    flat.height = CANVAS_HEIGHT;
    const ctx = flat.getContext('2d');
    if (!ctx) {
      setStatus('error');
      return;
    }
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, flat.width, flat.height);
    ctx.drawImage(canvas.current, 0, 0);

    const blob = await new Promise<Blob | null>((resolve) =>
      flat.toBlob(resolve, 'image/png'),
    );
    if (!blob) {
      setStatus('error');
      return;
    }

    const file = new File([blob], `${field.key}-signature.png`, { type: 'image/png' });
    const outcome = await captureAttachment(file, version.id, field.key);

    if (outcome.state === 'rejected') {
      setStatus('error');
      return;
    }

    setStatus(outcome.state === 'queued' ? 'queued' : 'idle');
    onChange(outcome.id);
  };

  if (attachmentId && savedPreview) {
    return (
      <div className="flex flex-col gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element -- a blob URL or
            an authorised proxy route; the image optimiser can fetch neither. */}
        <img
          src={savedPreview}
          alt=""
          className="w-full rounded-field border-2 border-affirm-500 bg-white"
        />
        {status === 'queued' ? (
          <p className="flex items-start gap-2 rounded-field bg-slate-100 p-3 text-field-sm text-slate-700">
            <CloudOff aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
            {m(locale, 'attachmentQueued')}
          </p>
        ) : null}
        <button
          type="button"
          onClick={clear}
          className="field-button border-2 border-slate-300 bg-white text-slate-800"
        >
          <PenLine aria-hidden className="h-5 w-5" />
          {m(locale, 'signatureRedo')}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-field-sm text-slate-600">{prompt || m(locale, 'signatureSign')}</p>

      <canvas
        ref={canvas}
        width={CANVAS_WIDTH}
        height={CANVAS_HEIGHT}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        // Without this the browser treats a stroke as a scroll gesture and the
        // page moves under the finger instead of a line being drawn.
        className="aspect-[900/320] w-full touch-none rounded-field border-2 border-dashed border-slate-400 bg-white"
      />

      {status === 'error' ? (
        <p role="alert" className="rounded-field bg-deny-50 p-3 text-field-sm text-deny-700">
          {m(locale, 'attachmentFailed')}
        </p>
      ) : null}

      <div className="flex gap-3">
        <button
          type="button"
          onClick={clear}
          className="field-button w-auto shrink-0 border-2 border-slate-300 bg-white px-5 text-slate-800"
        >
          <Eraser aria-hidden className="h-5 w-5" />
          {m(locale, 'signatureClear')}
        </button>
        <button
          type="button"
          disabled={status === 'saving' || status !== 'drawing'}
          onClick={commit}
          className="field-button bg-affirm-500 text-white disabled:opacity-50"
        >
          {status === 'saving' ? (
            <Loader2 aria-hidden className="h-5 w-5 animate-spin" />
          ) : (
            <Check aria-hidden className="h-5 w-5" />
          )}
          {m(locale, 'signatureDone')}
        </button>
      </div>
    </div>
  );
}
