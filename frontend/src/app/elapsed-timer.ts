/** Counts seconds while a request runs, so slow local models do not look frozen. */
export class ElapsedTimer {
  seconds = 0;
  private handle: ReturnType<typeof setInterval> | null = null;

  start(): void {
    this.stop();
    this.seconds = 0;
    this.handle = setInterval(() => this.seconds++, 1000);
  }

  stop(): void {
    if (this.handle !== null) {
      clearInterval(this.handle);
      this.handle = null;
    }
  }
}
