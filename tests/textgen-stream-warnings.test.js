import { beforeAll, describe, expect, jest, test } from '@jest/globals';

const warnings = [{ kind: 'dropped', key: 'k', message: 'Dropped: a', entries: ['a'] }];
const frames = [
    { content: 'Hi' },
    { control: { warnings } },
];

const showTokenizerWarnings = jest.fn();

globalThis.localStorage = { getItem: jest.fn(() => null), setItem: jest.fn() };
globalThis.document = { getElementById: jest.fn(() => null) };

jest.unstable_mockModule('../public/script.js', () => ({
    abortStatusCheck: { signal: undefined },
    getStoppingStrings: jest.fn(),
    online_status: '',
    resultCheckStatus: jest.fn(),
    saveSettingsDebounced: jest.fn(),
    setGenerationParamsFromPreset: jest.fn(),
    setOnlineStatus: jest.fn(),
    startStatusLoading: jest.fn(),
    substituteParams: jest.fn(),
}));
jest.unstable_mockModule('../public/scripts/generation-params.js', () => ({ main_api: 'textgenerationwebui', max_context: 8192 }));
jest.unstable_mockModule('../public/scripts/request-headers.js', () => ({ getRequestHeaders: jest.fn(() => ({})) }));
jest.unstable_mockModule('../public/scripts/events.js', () => ({ eventSource: { on: jest.fn(), emit: jest.fn() }, event_types: {} }));
jest.unstable_mockModule('../public/scripts/chat-templates.js', () => ({ deriveTemplatesFromChatTemplate: jest.fn() }));
jest.unstable_mockModule('../public/scripts/i18n.js', () => ({ t: (s) => String(s) }));
jest.unstable_mockModule('../public/scripts/instruct-mode.js', () => ({
    autoSelectInstructPreset: jest.fn(),
    selectContextPreset: jest.fn(),
    selectInstructPreset: jest.fn(),
}));
jest.unstable_mockModule('../public/scripts/logit-bias.js', () => ({
    buildLogitBiasListResult: jest.fn(),
    createNewLogitBiasEntry: jest.fn(),
    displayLogitBias: jest.fn(),
    getLogitBiasEntryTexts: jest.fn(),
}));
jest.unstable_mockModule('../public/scripts/power-user.js', () => ({ power_user: {}, registerDebugFunction: jest.fn() }));
jest.unstable_mockModule('../public/scripts/samplerSelect.js', () => ({
    getActiveManualApiSamplers: jest.fn(),
    loadApiSelectedSamplers: jest.fn(),
    isSamplerManualPriorityEnabled: jest.fn(),
}));
jest.unstable_mockModule('../public/scripts/secrets.js', () => ({ SECRET_KEYS: {}, writeSecret: jest.fn() }));
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
jest.unstable_mockModule('../public/scripts/textgen-models.js', () => ({
    getCurrentDreamGenModelTokenizer: jest.fn(),
    getCurrentOpenRouterModelTokenizer: jest.fn(),
    loadAphroditeModels: jest.fn(),
    loadDreamGenModels: jest.fn(),
    loadFeatherlessModels: jest.fn(),
    loadGenericModels: jest.fn(),
    loadInfermaticAIModels: jest.fn(),
    loadLlamaCppModels: jest.fn(),
    loadMancerModels: jest.fn(),
    loadOllamaModels: jest.fn(),
    loadOpenRouterModels: jest.fn(),
    loadTabbyModels: jest.fn(),
    loadTogetherAIModels: jest.fn(),
    loadVllmModels: jest.fn(),
    updateOpenRouterProvidersWarning: jest.fn(),
}));
jest.unstable_mockModule('../public/scripts/tokenizers.js', () => ({
    TOKENIZER_SUPPORTED_KEY: 'tokenizationSupported',
    getEntryTokenIds: jest.fn(),
    registerEntryTextSource: jest.fn(),
    showDroppedEntries: jest.fn(),
}));
jest.unstable_mockModule('../public/scripts/util/AbortReason.js', () => ({ AbortReason: {} }));
jest.unstable_mockModule('../public/scripts/utils.js', () => ({
    getSortableDelay: jest.fn(),
    onlyUnique: jest.fn(),
    arraysEqual: jest.fn(),
    isObject: jest.fn(),
}));
jest.unstable_mockModule('../public/scripts/textgen-setting-names.js', () => ({ setting_names: [] }));
jest.unstable_mockModule('../public/scripts/tokenizer-notices.js', () => ({ showTokenizerWarnings }));

let generateTextGenWithStreaming;

beforeAll(async () => {
    globalThis.fetch = jest.fn(async () => ({
        ok: true,
        headers: { get: (name) => (name === 'X-ST-Stream-Format' ? 'compact-v1' : null) },
    }));
    ({ generateTextGenWithStreaming } = await import('../public/scripts/textgen-settings.js'));
});

describe('textgen stream reader', () => {
    test('passes a {control:{warnings}} frame to showTokenizerWarnings', async () => {
        const streamData = await generateTextGenWithStreaming({}, new AbortController().signal);
        const stream = streamData();
        while (!(await stream.next()).done) { /* drain */ }
        expect(showTokenizerWarnings).toHaveBeenCalledWith(warnings);
    });
});
