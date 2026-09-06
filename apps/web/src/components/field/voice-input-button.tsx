'use client';

import { useEffect, useRef, useState } from 'react';
import { Mic, MicOff } from 'lucide-react';
import { SPEECH_LOCALES } from '@/lib/i18n';
import { m } from '@/lib/messages';

/**
 * Dictation for text answers.
 *
 * This is the single largest accommodation in the field UI. A worker who reads
 * confidently but types slowly — or who is more comfortable in Kannada than
 * with a Kannada keyboard — can answer by speaking. Chrome on Android supports
 * the major Indian languages.
 *
 * Progressive enhancement: where the API is missing the button simply does not
 * render, and the text field behaves normally.
 */

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
}

function getRecognition(): SpeechRecognitionLike | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  const Constructor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  return Constructor ? new Constructor() : null;
}

export function VoiceInputButton({
  locale,
  onTranscript,
}: {
  locale: string;
  onTranscript: (text: string) => void;
}) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  useEffect(() => {
    setSupported(getRecognition() !== null);
    return () => recognitionRef.current?.stop();
  }, []);

  if (!supported) return null;

  const toggle = () => {
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }

    const recognition = getRecognition();
    if (!recognition) return;

    recognition.lang = SPEECH_LOCALES[locale] ?? 'en-IN';
    recognition.interimResults = false;
    recognition.continuous = false;
    recognition.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript;
      if (transcript) onTranscript(transcript);
    };
    // Both handlers clear the listening state — without onerror, a denied
    // microphone permission would leave the button stuck mid-listen.
    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);

    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={listening ? m(locale, 'listening') : m(locale, 'speakAnswer')}
      aria-pressed={listening}
      className={
        listening
          ? 'flex min-h-tap min-w-tap items-center justify-center rounded-field bg-deny-500 text-white'
          : 'flex min-h-tap min-w-tap items-center justify-center rounded-field border-2 border-slate-300 bg-white text-slate-700'
      }
    >
      {listening ? <MicOff aria-hidden className="h-6 w-6" /> : <Mic aria-hidden className="h-6 w-6" />}
    </button>
  );
}
