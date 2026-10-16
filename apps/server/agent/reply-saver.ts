/** How often a short streaming reply is saved, at most. */
export const SAVE_INTERVAL_MS = 1000;
/** Each save rewrites the whole parts JSON: a reply this big waits a second more between saves. */
const BYTES_PER_SECOND = 250_000;

type Schedule = (run: () => void, ms: number) => () => void;

const schedule: Schedule = (run, ms) => {
  const timer = setTimeout(run, ms);
  timer.unref();
  return () => clearTimeout(timer);
};

/**
 * Saves a streaming reply now and then, so a restart, or another screen loading the chat, finds most of it. Each save
 * rewrites the reply's whole parts JSON (which reaches a megabyte on a long run of tool calls), so saves get rarer as
 * it grows (1 s, plus 1 s per 250 KB), and one only happens when something changed since the last: a change that
 * comes too soon is saved once the wait is up. The turn's final save is separate and always runs; stop() first.
 */
export class ReplySaver {
  private dirty = false;
  private lastSave = Number.NEGATIVE_INFINITY;
  private bytes = 0;
  private cancel: (() => void) | null = null;
  private stopped = false;

  /** `save` writes the reply and returns the size of its parts' JSON. */
  constructor(
    private readonly save: () => number,
    private readonly now: () => number = Date.now,
    private readonly later: Schedule = schedule,
  ) {}

  /** The wait between saves for a reply of the size last saved. */
  get interval(): number {
    return Math.max(SAVE_INTERVAL_MS, (this.bytes / BYTES_PER_SECOND) * 1000);
  }

  /** The reply changed: saved now if the last save was long enough ago, else when it is. */
  changed(): void {
    if (this.stopped) return;
    this.dirty = true;
    const wait = this.lastSave + this.interval - this.now();
    if (wait <= 0) this.flush();
    else this.cancel ??= this.later(() => this.flush(), wait);
  }

  /** Saves at once, e.g. a card the user must be able to answer from another screen. */
  saveNow(): void {
    if (this.stopped) return;
    this.dirty = true;
    this.flush();
  }

  /** The turn is over: no more saves from here (its final save follows). */
  stop(): void {
    this.stopped = true;
    this.cancel?.();
    this.cancel = null;
  }

  private flush(): void {
    this.cancel?.();
    this.cancel = null;
    if (!this.dirty || this.stopped) return;
    this.bytes = this.save();
    this.lastSave = this.now();
    this.dirty = false;
  }
}
