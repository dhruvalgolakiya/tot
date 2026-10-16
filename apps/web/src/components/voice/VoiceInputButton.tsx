import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { Mic, MicOff } from "lucide-react";
import { getSpeechRecognitionConstructor, type SpeechRecognitionLike } from "./speechRecognition";

export interface VoiceInputButtonProps {
  /** Called for every recognized chunk; `isFinal` marks the end of one utterance. */
  onTranscript: (text: string, isFinal: boolean) => void;
  disabled?: boolean;
  className?: string;
}

/** Whether this browser exposes (possibly vendor-prefixed) SpeechRecognition. Fixed for the session. */
const supported = getSpeechRecognitionConstructor() !== null;

/**
 * Mic button backed by the browser's Web Speech API: click (or Enter/Space)
 * to start listening, click again or press Esc to stop. Renders nothing in
 * browsers without SpeechRecognition support (most notably Firefox).
 */
export function VoiceInputButton({ onTranscript, disabled, className }: VoiceInputButtonProps) {
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
  }, []);

  // Stop for good on unmount, and whenever the caller disables the button mid-listen.
  useEffect(() => () => recognitionRef.current?.stop(), []);
  useEffect(() => {
    if (disabled) stop();
  }, [disabled, stop]);

  useEffect(() => {
    if (!listening) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") stop();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [listening, stop]);

  function start() {
    const Ctor = getSpeechRecognitionConstructor();
    if (!Ctor) return;
    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language;
    recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        onTranscriptRef.current(result[0].transcript, result.isFinal);
      }
    };
    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);
    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
  }

  if (!supported) return null;

  return (
    <button
      type="button"
      aria-label={listening ? "Stop voice input" : "Start voice input"}
      aria-pressed={listening}
      disabled={disabled}
      onClick={() => (listening ? stop() : start())}
      className={clsx(
        "relative inline-flex size-9 shrink-0 items-center justify-center rounded-full transition-colors disabled:pointer-events-none disabled:opacity-40",
        listening ? "text-accent-text" : "text-fg-muted hover:bg-hover hover:text-fg",
        className,
      )}
    >
      {listening && (
        <>
          <span className="absolute inset-1 animate-ping rounded-full bg-accent-soft-hover" />
          <span className="absolute inset-1.5 rounded-full bg-accent-soft" />
        </>
      )}
      {disabled ? <MicOff className="relative size-4.5" /> : <Mic className="relative size-4.5" />}
    </button>
  );
}
