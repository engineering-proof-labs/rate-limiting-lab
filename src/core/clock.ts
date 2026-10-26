import type { Clock } from './types.js';

export class SystemClock implements Clock {
  public now(): number {
    return Date.now();
  }
}

export class VirtualClock implements Clock {
  private currentTimeMs: number;

  constructor(initialTimeMs = 0) {
    this.currentTimeMs = initialTimeMs;
  }

  public now(): number {
    return this.currentTimeMs;
  }

  public advance(deltaMs: number): void {
    if (deltaMs < 0) {
      throw new Error('VirtualClock cannot advance backwards');
    }
    this.currentTimeMs += deltaMs;
  }

  public setTime(timestampMs: number): void {
    this.currentTimeMs = timestampMs;
  }
}
