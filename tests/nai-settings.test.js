import { beforeAll, describe, expect, jest, test } from '@jest/globals';

const jqueryElement = {
    append: jest.fn(function () { return this; }),
    children: jest.fn(() => ({ each: jest.fn() })),
    detach: jest.fn(function () { return this; }),
    empty: jest.fn(function () { return this; }),
    find: jest.fn(function () { return this; }),
    on: jest.fn(function () { return this; }),
    prop: jest.fn(function () { return this; }),
    trigger: jest.fn(function () { return this; }),
    val: jest.fn(function () { return this; }),
};

global.$ = jest.fn(() => jqueryElement);

jest.unstable_mockModule('../public/script.js', () => ({
    abortStatusCheck: { signal: undefined },
    event_types: {},
    eventSource: { emit: jest.fn() },
    getRequestHeaders: jest.fn(),
    getStoppingStrings: jest.fn(),
    resultCheckStatus: jest.fn(),
    saveSettings: jest.fn(),
    saveSettingsDebounced: jest.fn(),
    setOnlineStatus: jest.fn(),
    startStatusLoading: jest.fn(),
}));
jest.unstable_mockModule('../public/scripts/power-user.js', () => ({
    MAX_CONTEXT_DEFAULT: 8192,
    MAX_RESPONSE_DEFAULT: 150,
    power_user: {},
}));
jest.unstable_mockModule('../public/scripts/tokenizers.js', () => ({
    getEntryTokenIds: jest.fn(),
    getTokenizerBestMatch: jest.fn(),
    registerEntryTextSource: jest.fn(),
    showDroppedEntries: jest.fn(),
    tokenizers: { NONE: 0 },
}));
jest.unstable_mockModule('../public/scripts/utils.js', () => ({
    getSortableDelay: jest.fn(),
    onlyUnique: jest.fn(),
}));
jest.unstable_mockModule('../public/scripts/logit-bias.js', () => ({
    buildLogitBiasListResult: jest.fn(),
    createNewLogitBiasEntry: jest.fn(),
    displayLogitBias: jest.fn(),
    getLogitBiasEntryTexts: jest.fn(),
}));
jest.unstable_mockModule('../public/scripts/secrets.js', () => ({
    SECRET_KEYS: {},
    secret_state: {},
    writeSecret: jest.fn(),
}));

let loadNovelPreset;
let loadNovelSettings;
let applyNovelPreset;
let naiSettings;

beforeAll(async () => {
    ({
        loadNovelPreset,
        loadNovelSettings,
        applyNovelPreset,
        nai_settings: naiSettings,
    } = await import('../public/scripts/nai-settings.js'));
});

describe('NovelAI settings', () => {
    test('preserves a zero Math1 temperature when loading settings', () => {
        loadNovelSettings(
            { novelai_setting_names: [], novelai_settings: [] },
            { ...naiSettings, math1_temp: 0 },
        );
        expect(naiSettings.math1_temp).toBe(0);

        naiSettings.math1_temp = 1;
        loadNovelPreset({ ...naiSettings, genamt: 150, math1_temp: 0 });
        expect(naiSettings.math1_temp).toBe(0);
    });

    test('applying a catalog name waits for persistence and updates the generation settings directly', async () => {
        const { saveSettings } = await import('../public/script.js');
        loadNovelSettings({ novelai_setting_names: ['Direct'], novelai_settings: [JSON.stringify({ ...naiSettings, temperature: 1.25, math1_temp: 0 })] }, { ...naiSettings });
        let finish;
        saveSettings.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        let done = false;
        const applying = applyNovelPreset('Direct').then(() => { done = true; });
        expect(naiSettings.preset_settings_novel).toBe('Direct');
        expect(naiSettings.temperature).toBe(1.25);
        expect(naiSettings.math1_temp).toBe(0);
        expect(saveSettings).toHaveBeenLastCalledWith('nai_settings');
        expect(done).toBe(false);
        finish();
        await applying;
        expect(done).toBe(true);
    });
});
