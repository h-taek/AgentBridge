// 외부에서 push/close 가능한 단일 소비자 async 큐.
// 두 군데 재사용: (1) SDK streaming-input(`AsyncIterable<SDKUserMessage>`) 공급, (2) 턴별 ChatEvent 스트림.
// 소비자는 항상 하나(SDK 또는 send 제너레이터)라 락 없이 안전.
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiting: ((r: IteratorResult<T>) => void) | null = null;
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w({ value: undefined as unknown as T, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift() as T, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as unknown as T, done: true });
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}
