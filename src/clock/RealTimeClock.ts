import { IClock } from '../types';

/**
 * Real-time clock that delegates to the actual system clock.
 */
export class RealTimeClock implements IClock {
  private nextId = 1;
  private timers: Map<number, ReturnType<typeof setTimeout>> = new Map();

  now(): number {
    return Date.now();
  }

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId++;
    const handle = globalThis.setTimeout(() => {
      this.timers.delete(id);
      callback();
    }, delayMs);
    this.timers.set(id, handle);
    return id;
  }

  clearTimeout(id: number): void {
    const handle = this.timers.get(id);
    if (handle !== undefined) {
      globalThis.clearTimeout(handle);
      this.timers.delete(id);
    }
  }
}
