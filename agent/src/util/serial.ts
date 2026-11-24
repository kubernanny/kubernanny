/**
 * Runs async tasks one after the other. The services that keep state in a
 * Secret or ConfigMap read, change and write it back; two requests at once
 * would otherwise both start from the same state, and the second write
 * would undo the first.
 */
export class Serial {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    // A failed task must not stop the ones after it.
    this.tail = result.catch(() => undefined);
    return result;
  }
}
