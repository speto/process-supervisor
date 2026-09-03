export class OwnershipCoordinator {
  private tail: Promise<void> = Promise.resolve();
  private accepting = true;
  private closing: Promise<void> | null = null;

  get isAccepting(): boolean {
    return this.accepting;
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.accepting) return Promise.reject(new Error('Ownership coordinator is closing.'));
    return this.enqueue(operation);
  }

  runInternal<T>(operation: () => Promise<T>): Promise<T> {
    return this.enqueue(operation);
  }

  close(operation: () => Promise<void>): Promise<void> {
    if (this.closing) return this.closing;
    this.accepting = false;
    const closing = this.enqueue(operation);
    this.closing = closing;
    void closing.catch(() => {
      if (this.closing !== closing) return;
      this.closing = null;
      this.accepting = true;
    });
    return closing;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
