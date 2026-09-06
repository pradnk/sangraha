'use client';

import { useEffect, useRef, useState } from 'react';
import { Crosshair, Loader2, MapPin, RotateCcw, TriangleAlert, X } from 'lucide-react';
import { m } from '@/lib/messages';
import type { QuestionInputProps } from './question-input';

/**
 * A GPS reading.
 *
 * Two things make this harder than calling `getCurrentPosition` once.
 *
 * The first fix a phone returns is usually the cell-tower estimate — accurate
 * to a kilometre or worse — and the satellite fix arrives seconds later. Asking
 * once and taking the answer records a village-sized blur as if it were a
 * building. So this *watches*, keeps the best reading it has seen, and stops as
 * soon as one is good enough or the clock runs out.
 *
 * The second is that a bad reading is worse than none. A point that is silently
 * 2 km out cannot be told apart from a good one later, and it will be mapped,
 * reported and believed. So a reading worse than the question's threshold is
 * shown as a problem rather than accepted quietly — and can only be kept if the
 * admin allowed the override, deliberately, when building the form.
 */

/** Long enough for a satellite fix, short enough not to strand a worker. */
const WATCH_TIMEOUT_MS = 20_000;

interface Reading {
  lat: number;
  lon: number;
  accuracy?: number;
  capturedAt?: string;
}

type Phase = 'idle' | 'locating' | 'rough' | 'denied' | 'unavailable';

function asReading(value: unknown): Reading | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.lat === 'number' && typeof candidate.lon === 'number'
    ? (candidate as unknown as Reading)
    : null;
}

export function GeopointAnswer({ config, value, locale, onChange }: QuestionInputProps) {
  const requiredAccuracy = Number(config.requiredAccuracyM ?? 100);
  const allowOverride = config.allowManualOverride !== false;

  const saved = asReading(value);
  const [phase, setPhase] = useState<Phase>('idle');
  /** The best fix of this attempt, kept even when it is not good enough. */
  const [best, setBest] = useState<Reading | null>(null);

  // Held in a ref as well as state: the cleanup path needs the current id
  // without re-running the effect and cancelling the watch it just started.
  const watchId = useRef<number | null>(null);
  const timer = useRef<number | null>(null);

  const stop = () => {
    if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current);
    if (timer.current !== null) window.clearTimeout(timer.current);
    watchId.current = null;
    timer.current = null;
  };

  // A worker who leaves the question mid-search should not leave the GPS on.
  // On a low-end phone an abandoned watch is a measurable share of the battery.
  useEffect(() => stop, []);

  const start = () => {
    if (!('geolocation' in navigator)) {
      setPhase('unavailable');
      return;
    }

    stop();
    setBest(null);
    setPhase('locating');

    let bestSoFar: Reading | null = null;

    const finish = () => {
      stop();
      if (!bestSoFar) {
        setPhase('unavailable');
        return;
      }
      // Good enough is saved without further ceremony; anything else is shown
      // to the worker as a decision they have to make.
      if ((bestSoFar.accuracy ?? Infinity) <= requiredAccuracy) {
        onChange(bestSoFar);
        setPhase('idle');
      } else {
        setPhase('rough');
      }
    };

    watchId.current = navigator.geolocation.watchPosition(
      (position) => {
        const reading: Reading = {
          lat: position.coords.latitude,
          lon: position.coords.longitude,
          accuracy:
            typeof position.coords.accuracy === 'number'
              ? Math.round(position.coords.accuracy)
              : undefined,
          capturedAt: new Date().toISOString(),
        };

        // Strictly better only. A later, vaguer fix must not replace a good one.
        if (!bestSoFar || (reading.accuracy ?? Infinity) < (bestSoFar.accuracy ?? Infinity)) {
          bestSoFar = reading;
          setBest(reading);
        }

        if ((reading.accuracy ?? Infinity) <= requiredAccuracy) finish();
      },
      (error) => {
        stop();
        // Permission is the one failure the worker can do something about, and
        // it needs different words from "no signal here".
        setPhase(error.code === error.PERMISSION_DENIED ? 'denied' : 'unavailable');
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: WATCH_TIMEOUT_MS },
    );

    timer.current = window.setTimeout(finish, WATCH_TIMEOUT_MS);
  };

  if (phase === 'locating') {
    return (
      <div className="flex flex-col gap-3">
        <p className="flex items-center gap-3 rounded-field bg-brand-50 p-4 text-field-base text-brand-900">
          <Loader2 aria-hidden className="h-6 w-6 shrink-0 animate-spin" />
          {m(locale, 'gpsFinding')}
        </p>
        {best?.accuracy ? (
          // Shown while it improves, so the wait is visibly doing something.
          <p className="text-field-sm text-slate-500">
            {m(locale, 'gpsAccuracy', { metres: best.accuracy })}
          </p>
        ) : null}
        <button
          type="button"
          onClick={() => {
            stop();
            setPhase('idle');
          }}
          className="field-button border-2 border-slate-300 bg-white text-slate-800"
        >
          <X aria-hidden className="h-5 w-5" />
          {m(locale, 'cancel')}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {saved ? (
        <div className="flex flex-col gap-2 rounded-field border-2 border-affirm-500 bg-affirm-50 p-4">
          <p className="flex items-center gap-2 text-field-base font-semibold text-affirm-700">
            <MapPin aria-hidden className="h-5 w-5 shrink-0" />
            {m(locale, 'gpsSaved')}
          </p>
          {/* Six decimal places is about 10 cm — more would imply a precision
              no phone has. Shown at all because a worker who has been asked to
              re-take a reading needs to see that it changed. */}
          <p className="font-mono text-field-sm text-slate-700">
            {saved.lat.toFixed(6)}, {saved.lon.toFixed(6)}
          </p>
          {saved.accuracy ? (
            <p className="text-field-sm text-slate-600">
              {m(locale, 'gpsAccuracy', { metres: saved.accuracy })}
            </p>
          ) : null}
        </div>
      ) : null}

      {phase === 'rough' && best ? (
        <div className="flex flex-col gap-3 rounded-field border-2 border-amber-400 bg-amber-50 p-4">
          <p className="flex items-start gap-2 text-field-base text-amber-900">
            <TriangleAlert aria-hidden className="mt-0.5 h-5 w-5 shrink-0" />
            {m(locale, 'gpsTooRough', { metres: best.accuracy ?? 0 })}
          </p>
          {allowOverride ? (
            // Offered second, and worded as a concession rather than a choice.
            // The admin turned this on knowing a rough point is sometimes
            // better than nothing; the worker should still try again first.
            <button
              type="button"
              onClick={() => {
                onChange(best);
                setPhase('idle');
              }}
              className="field-button border-2 border-amber-500 bg-white text-amber-900"
            >
              {m(locale, 'gpsUseAnyway')}
            </button>
          ) : null}
        </div>
      ) : null}

      {phase === 'denied' ? (
        <p className="rounded-field bg-deny-50 p-4 text-field-sm text-deny-700">
          {m(locale, 'gpsDenied')}
        </p>
      ) : null}

      {phase === 'unavailable' ? (
        <p className="rounded-field bg-deny-50 p-4 text-field-sm text-deny-700">
          {m(locale, 'gpsUnavailable')}
        </p>
      ) : null}

      <button
        type="button"
        onClick={start}
        className={
          saved
            ? 'field-button border-2 border-slate-300 bg-white text-slate-800'
            : 'field-button bg-brand-600 text-white'
        }
      >
        {saved ? (
          <RotateCcw aria-hidden className="h-5 w-5" />
        ) : (
          <Crosshair aria-hidden className="h-5 w-5" />
        )}
        {saved ? m(locale, 'gpsRetry') : m(locale, 'gpsGetLocation')}
      </button>

      {saved ? (
        <button
          type="button"
          onClick={() => onChange(null)}
          className="field-button border-2 border-slate-300 bg-white text-slate-600"
        >
          <X aria-hidden className="h-5 w-5" />
          {m(locale, 'remove')}
        </button>
      ) : null}
    </div>
  );
}
