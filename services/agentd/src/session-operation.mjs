export class SessionOperationCoordinator {
  constructor() {
    this.tails = new Map();
  }

  async run(sessionId, operation) {
    const previous = this.tails.get(sessionId) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.tails.set(sessionId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId);
    }
  }
}

export async function withForumMutableSessionOperation(coordinator, ledgers, sessionId, operation) {
  return coordinator.run(sessionId, async () => {
    // This check intentionally lives inside the same critical section as the
    // mutation. A branch operation that wins the lock publishes its durable
    // source fence before a queued writer may inspect mutability.
    const { assertForumForkSourceMutable } = await import('./forum-fork-operation.mjs');
    for (const ledger of Array.isArray(ledgers) ? ledgers : [ledgers]) {
      await assertForumForkSourceMutable(ledger, sessionId);
    }
    return operation();
  });
}
