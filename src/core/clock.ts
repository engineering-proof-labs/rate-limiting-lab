import type { Clock } from './types.js';

export class SystemClock implements Clock {
  public now(): number {
    return Date.now();
  }
}

export class VirtualClock implements Clock {
  private currentTimeMs: number;

  constructor(initialTimeMs = 0) {
    if (!Number.isSafeInteger(initialTimeMs) || initialTimeMs < 0) {
      throw new Error('Initial timestamp must be a non-negative safe integer');
    }
    this.currentTimeMs = initialTimeMs;
  }

  public now(): number {
    return this.currentTimeMs;
  }

  public advance(deltaMs: number): void {
    if (!Number.isSafeInteger(deltaMs) || deltaMs < 0) {
      throw new Error('Advance delta must be a non-negative safe integer');
    }
    const next = this.currentTimeMs + deltaMs;
    if (!Number.isSafeInteger(next)) {
      throw new Error('Resulting timestamp exceeds maximum safe integer');
    }
    this.currentTimeMs = next;
  }

  public setTime(timestampMs: number): void {
    if (!Number.isSafeInteger(timestampMs) || timestampMs < 0) {
      throw new Error('Timestamp must be a non-negative safe integer');
    }
    this.currentTimeMs = timestampMs;
  }
}
