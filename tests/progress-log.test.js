import { test, expect } from '@jest/globals';

import { ProgressLog, formatDuration } from '../src/progress-log.js';

/** A ProgressLog on a clock the test moves. */
function makeLog(total) {
    const lines = [];
    let now = 0;
    const progress = new ProgressLog({ what: 'search index', total, log: line => lines.push(line.replace(/\u001b\[\d+m/g, '')), now: () => now });
    return { lines, progress, advance: ms => { now += ms; } };
}

test('a pass that finishes before the first interval logs only its finished line', () => {
    const { lines, progress, advance } = makeLog(100);
    for (let i = 0; i < 100; i++) {
        progress.add();
        advance(10);
    }
    progress.finish('3 changed');
    expect(lines).toEqual(['search index: done, 100 in 1 s, 3 changed']);
});

test('a long pass logs at most one progress line per interval, with how far it is and how long is left, and no batch numbers', () => {
    const { lines, progress, advance } = makeLog(380000);
    // 1000 items every 100 ms: 10,000 a second.
    for (let i = 0; i < 380; i++) {
        advance(100);
        progress.add(1000);
    }
    progress.finish();
    const progressLines = lines.slice(0, -1);
    expect(progressLines.length).toBe(3);
    expect(progressLines[0]).toBe('search index: 100,000 of 380,000 (26%), about 28 s left');
    for (const line of lines) expect(line).not.toMatch(/batch/i);
    expect(lines.at(-1)).toBe('search index: done, 380,000 in 38 s');
});

test('without a known total it says how many so far', () => {
    const { lines, progress, advance } = makeLog(null);
    advance(10_000);
    progress.add(1234);
    expect(lines).toEqual(['search index: 1,234 so far']);
});

test('durations read in plain words', () => {
    expect(formatDuration(4_000)).toBe('4 s');
    expect(formatDuration(150_000)).toBe('3 min');
    expect(formatDuration(80 * 60_000)).toBe('1 h 20 min');
    expect(formatDuration(2 * 60 * 60_000)).toBe('2 h');
});
