/** Tracks best-effort maintenance so shutdown can stop scheduling and join active work before SQLite closes. */
export class MaintenanceTracker {
  private accepting = true;
  private readonly active = new Set<Promise<unknown>>();

  run(task: () => Promise<unknown>): void {
    if (!this.accepting) return;
    const promise = task();
    this.active.add(promise);
    void promise.then(
      () => this.active.delete(promise),
      () => this.active.delete(promise)
    );
  }

  close(): void {
    this.accepting = false;
  }

  async waitForIdle(): Promise<void> {
    await Promise.allSettled([...this.active]);
  }
}
