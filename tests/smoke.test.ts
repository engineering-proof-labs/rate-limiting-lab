import { describe, it, expect } from 'vitest';
import { getLabVersion, LAB_METADATA } from '../src/index.js';

describe('Toolchain Smoke Test', () => {
  it('loads module exports correctly', () => {
    expect(LAB_METADATA.name).toBe('rate-limiting-lab');
    expect(getLabVersion()).toBe('0.1.0');
  });

  it('executes asynchronous assertions properly', async () => {
    const value = await Promise.resolve(42);
    expect(value).toBe(42);
  });
});
