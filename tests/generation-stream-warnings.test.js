import { beforeAll, describe, expect, jest, test } from '@jest/globals';

const warnings = [{ kind: 'dropped', key: 'k', message: 'Dropped: a', entries: ['a'] }];
const frames = [
    { content: 'Hi' },
    { control: { warnings } },
];

const showTokenizerWarnings = jest.fn();

jest.unstable_mockModule('../public/scripts/request-headers.js', () => ({ getRequestHeaders: jest.fn(() => ({})) }));
jest.unstable_mockModule('../public/scripts/generation-stop.js', () => ({
    beginServerGeneration: jest.fn(() => 'id'),
    endServerGeneration: jest.fn(),
    streamServerGeneration: jest.fn(),
    takeStopResult: jest.fn(),
}));
jest.unstable_mockModule('../public/scripts/stored-report.js', () => ({ reportStored: jest.fn(), reportStoredHeader: jest.fn() }));
jest.unstable_mockModule('../public/scripts/textgen-settings.js', () => ({ parseTextgenLogprobs: jest.fn(() => null) }));
jest.unstable_mockModule('../public/scripts/nai-settings.js', () => ({ parseNovelAILogprobs: jest.fn(() => null) }));
jest.unstable_mockModule('../public/scripts/templates.js', () => ({ renderTemplateAsync: jest.fn() }));
jest.unstable_mockModule('../public/scripts/popup.js', () => ({ Popup: { show: { text: jest.fn() } } }));
jest.unstable_mockModule('../public/scripts/i18n.js', () => ({ t: (s) => String(s) }));
jest.unstable_mockModule('../public/scripts/llamacpp-compact-stream.js', () => ({
    CompactStreamDecoder: class {
        push() { return frames; }
        flush() { return []; }
    },
    ResumableCompactStreamReader: class {
        constructor() { this.sent = false; }
        async read() {
            if (this.sent) return { done: true, value: undefined };
            this.sent = true;
            return { done: false, value: new Uint8Array([1]) };
        }
    },
}));
jest.unstable_mockModule('../public/scripts/tokenizer-notices.js', () => ({ showTokenizerWarnings }));

let sendGeneration;

beforeAll(async () => {
    globalThis.fetch = jest.fn(async () => ({
        ok: true,
        headers: { get: (name) => ({ 'X-ST-Stream-Format': 'compact-v1', 'X-ST-Connection': 'textgenerationwebui' })[name] ?? null },
    }));
    ({ sendGeneration } = await import('../public/scripts/generation-request.js'));
});

describe('generation stream reader', () => {
    test('passes a {control:{warnings}} frame to showTokenizerWarnings', async () => {
        const answer = await sendGeneration({}, new AbortController().signal);
        expect(answer.connection).toBe('textgenerationwebui');
        const stream = answer.stream();
        while (!(await stream.next()).done) { /* drain */ }
        expect(showTokenizerWarnings).toHaveBeenCalledWith(warnings);
    });
});
