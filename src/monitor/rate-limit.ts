export class BackoffController {
  private attempt = 0;
  private readonly baseMs: number;
  private readonly maxMs: number;
  private readonly multiplier: number;

  constructor(opts?: { baseMs?: number; maxMs?: number; multiplier?: number }) {
    this.baseMs = opts?.baseMs ?? 30_000;
    this.maxMs = opts?.maxMs ?? 600_000; // 10 minutes
    this.multiplier = opts?.multiplier ?? 2;
  }

  nextDelay(): number {
    const delay = Math.min(
      this.baseMs * Math.pow(this.multiplier, this.attempt),
      this.maxMs
    );
    this.attempt++;
    return delay;
  }

  reset(): void {
    this.attempt = 0;
  }

  get currentAttempt(): number {
    return this.attempt;
  }

  async wait(): Promise<void> {
    const delay = this.nextDelay();
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)}m`;
}
