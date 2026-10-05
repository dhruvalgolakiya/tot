/**
 * Local typings for the browser Web Speech API. TypeScript's DOM lib doesn't
 * reliably declare `SpeechRecognition` (and never declares the vendor-prefixed
 * `webkitSpeechRecognition`), so this file defines only the small surface
 * VoiceInputButton actually uses, under names that can't collide with lib.dom.
 */

import { totDesktop } from "../../lib/desktop";

export interface SpeechRecognitionAlternativeLike {
  readonly transcript: string;
  readonly confidence: number;
}

export interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: SpeechRecognitionAlternativeLike;
}

export interface SpeechRecognitionResultListLike {
  readonly length: number;
  [index: number]: SpeechRecognitionResultLike;
}

export interface SpeechRecognitionEventLike extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultListLike;
}

export interface SpeechRecognitionErrorEventLike extends Event {
  readonly error: string;
}

export interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

/**
 * Returns the browser's (possibly vendor-prefixed) constructor, or null when unsupported.
 * Browsers only grant the microphone on HTTPS or localhost, so plain-http LAN access has no voice. The Mac
 * app has none either: Electron declares the API but lacks Chrome's speech service, so it never transcribes.
 */
export function getSpeechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined" || !window.isSecureContext || totDesktop) return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}
