import { describe, expect, it, vi } from 'vitest';

// Minimal in-memory stand-in for the three counter queries nextSeq issues.
const state = { counter: undefined as number | undefined, maxSeq: 0 };
vi.mock('@forge/sql', () => ({
  sql: {
    prepare: (query: string) => {
      let params: unknown[] = [];
      const stmt = {
        bindParams: (...p: unknown[]) => ((params = p), stmt),
        execute: async () => {
          await new Promise((r) => setTimeout(r, Math.random() * 5)); // interleave callers
          if (query.startsWith('INSERT IGNORE INTO counters')) {
            state.counter ??= state.maxSeq;
            return { rows: { affectedRows: 1 } };
          }
          if (query.startsWith('SELECT n FROM counters')) return { rows: [{ n: state.counter }] };
          if (query.startsWith('UPDATE counters')) {
            const [next, expected] = params as number[];
            if (state.counter !== expected) return { rows: { affectedRows: 0 } };
            state.counter = next;
            return { rows: { affectedRows: 1 } };
          }
          throw new Error(`unexpected query: ${query}`);
        },
      };
      return stmt;
    },
  },
}));

// vi.mock is hoisted above this import.
import { nextSeq } from '../src/db/decisions';

describe('nextSeq', () => {
  it('hands out unique, gap-free numbers to concurrent callers', async () => {
    state.counter = undefined;
    state.maxSeq = 0;
    const got = await Promise.all(Array.from({ length: 12 }, () => nextSeq()));
    expect([...got].sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  });

  it('starts above numbers already in use', async () => {
    state.counter = undefined;
    state.maxSeq = 7;
    expect(await nextSeq()).toBe(8);
  });
});
