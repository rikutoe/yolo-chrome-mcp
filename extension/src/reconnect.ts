const INITIAL_DELAY_MS = 2_000;
const MAX_DELAY_MS = 60_000;

type TimerHandle = ReturnType<typeof setTimeout>;
type SetTimer = (callback: () => void, delayMs: number) => TimerHandle;
type ClearTimer = (handle: TimerHandle) => void;

export class ReconnectScheduler {
  private timer: TimerHandle | null = null;
  private delayMs = 0;

  constructor(
    private readonly reconnect: () => void,
    private readonly setTimer: SetTimer = setTimeout,
    private readonly clearTimer: ClearTimer = clearTimeout,
  ) {}

  get isScheduled(): boolean {
    return this.timer !== null;
  }

  schedule(): boolean {
    if (this.timer !== null) return false;
    this.delayMs =
      this.delayMs === 0
        ? INITIAL_DELAY_MS
        : Math.min(this.delayMs * 2, MAX_DELAY_MS);
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.reconnect();
    }, this.delayMs);
    return true;
  }

  reset(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.delayMs = 0;
  }
}
