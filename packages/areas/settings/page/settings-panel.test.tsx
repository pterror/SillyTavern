import { createRoot, createSignal } from 'solid-js';
import type { JSX } from 'solid-js';
import { render } from 'solid-js/web';
import { expect, test } from 'vite-plus/test';
import { FIELDS } from '../protocol.ts';
import type { SettingsView } from '../protocol.ts';
import type { Client } from '@st/page/client';
import { UiProvider } from '@st/page/context';
import { LevelSlider } from './LevelSlider.tsx';
import { CcOptions, CcSamplers, CcUtility } from './cc.tsx';
import { TgSamplers, TgTop } from './tg.tsx';
import { CommonLengths } from './common.tsx';
import type { Support } from './cc.tsx';
import { isShown } from './fields.tsx';
import { settingsCompat } from './compat.ts';

function viewOf(over: Partial<SettingsView> = {}): SettingsView {
    return {
        context: { avatar: 'cara.png' },
        range: { from: 'default', to: 'user' },
        values: {
            'oai_settings.temp_openai': 1.2,
            'oai_settings.names_behavior': 0,
            'oai_settings.show_thoughts': false,
            'oai_settings.function_calling': true,
            'oai_settings.assistant_prefill': '',
            'oai_settings.assistant_impersonation': '',
        },
        sources: { 'oai_settings.temp_openai': 'user' },
        counts: { user: 1, character: 3 },
        ranges: {},
        api: { main: 'openai', source: 'openai', textgen: '' },
        zen: false,
        samplerSelects: {},
        ...over,
    };
}

function stand(view: SettingsView, answer: { ok: true } | { ok: false; error: string } = { ok: true }) {
    const [current, setCurrent] = createSignal<SettingsView>(view);
    const sent: { type: string; payload: unknown }[] = [];
    const client: Client = {
        send: async (type, payload) => {
            sent.push({ type, payload });
            return answer;
        },
        view: <T,>() => current as unknown as () => T | undefined,
        receive: () => {},
        reconnected: async () => {},
        reread: async () => {},
        version: () => 0,
    };
    return { client, sent, setCurrent };
}

function mount(
    view: SettingsView,
    surface: () => JSX.Element,
    answer: { ok: true } | { ok: false; error: string } = { ok: true },
) {
    const stood = stand(view, answer);
    const host = document.createElement('div');
    host.id = 'openai_settings';
    document.body.append(host);
    createRoot(() =>
        render(() => <UiProvider value={{ client: stood.client, t: (text) => text }}>{surface()}</UiProvider>, host),
    );
    return { host, ...stood };
}

const support = () => ({ functionCalling: true, image: false, video: false, audio: false }) satisfies Support;
const field = (id: string) => {
    const found = FIELDS.find((f) => f.id === id);
    if (!found) throw new Error(id);
    return found;
};
const settle = async () => {
    await Promise.resolve();
    await Promise.resolve();
};

test('a field shows for the sources, backends and APIs it names', () => {
    const api = { main: 'openai', source: 'claude', textgen: 'llamacpp' };
    expect(isShown(field('temp_openai'), api)).toBe(true);
    expect(isShown(field('freq_pen_openai'), api)).toBe(false);
    expect(isShown(field('dry_multiplier_textgenerationwebui'), api)).toBe(true);
    expect(isShown(field('top_k_textgenerationwebui'), { ...api, textgen: 'generic' })).toBe(false);
    expect(isShown(field('amount_gen'), api)).toBe(false);
});

test('each field is drawn under its old ids with its value, and only for the sources it names', () => {
    const { host } = mount(viewOf(), () => <CcSamplers />);
    expect(host.querySelector<HTMLInputElement>('#temp_openai')?.value).toBe('1.2');
    expect(host.querySelector<HTMLInputElement>('#temp_counter_openai')?.value).toBe('1.2');
    expect(host.querySelector('#temp_openai')?.closest('[data-field]')?.getAttribute('data-field')).toBe('temp_openai');
    expect(host.querySelector('#freq_pen_openai')).not.toBeNull();
    expect(host.querySelector('#top_k_openai')).toBeNull();
});

test("a chat's level is marked; a range above the defaults dims what nothing in it sets", () => {
    const character = mount(
        viewOf({ range: { from: 'default', to: 'character' }, sources: { 'oai_settings.temp_openai': 'character' } }),
        () => <CcSamplers />,
    );
    const block = character.host.querySelector('[data-field="temp_openai"]');
    expect(block?.getAttribute('data-settings-level')).toBe('character');
    block?.querySelector<HTMLButtonElement>('.settings_unset')?.click();
    expect(character.sent.at(-1)).toEqual({ type: 'settings.unset', payload: { path: 'oai_settings.temp_openai' } });

    const above = mount(viewOf({ range: { from: 'user', to: 'character' }, sources: {} }), () => <CcSamplers />);
    expect(above.host.querySelector('[data-field="temp_openai"]')?.getAttribute('data-settings-level')).toBe('unset');
});

test("an edit is sent as the field's value; a refused one goes back and says why", async () => {
    const { host, sent } = mount(viewOf(), () => <CcSamplers />, { ok: false, error: 'Temperature: at most 2' });
    const temp = host.querySelector<HTMLInputElement>('#temp_counter_openai');
    if (!temp) throw new Error('no control');
    temp.value = '1.9';
    temp.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(sent).toEqual([{ type: 'settings.set', payload: { path: 'oai_settings.temp_openai', value: 1.9 } }]);
    expect(temp.value).toBe('1.2');
    expect(host.querySelector('.settings_refusal')?.textContent).toBe('Temperature: at most 2');
});

test('a choice is its radios under their old ids, its choice named in the header', () => {
    const { host, sent } = mount(viewOf(), () => <CcOptions support={support} />);
    expect(host.querySelector<HTMLInputElement>('#character_names_default')?.checked).toBe(true);
    expect(host.querySelector('#character_names_display')?.textContent).toBe('Default');
    host.querySelector<HTMLInputElement>('#character_names_completion')?.click();
    expect(sent.at(-1)).toEqual({ type: 'settings.set', payload: { path: 'oai_settings.names_behavior', value: 1 } });
});

test('what depends on another field follows its value: tool reasoning, the prefill warning', () => {
    const { host, setCurrent } = mount(viewOf({ api: { main: 'openai', source: 'claude', textgen: '' } }), () => (
        <CcOptions support={support} />
    ));
    expect(host.querySelector<HTMLSelectElement>('#tool_reasoning_mode')).toBeNull();
    expect(host.querySelector('#claude_function_prefill_warning')).toBeNull();
    setCurrent(
        viewOf({
            api: { main: 'openai', source: 'claude', textgen: '' },
            values: { ...viewOf().values, 'oai_settings.assistant_prefill': 'Sure,' },
        }),
    );
    expect(host.querySelector('#claude_function_prefill_warning')).not.toBeNull();

    setCurrent(viewOf({ api: { main: 'openai', source: 'openrouter', textgen: '' } }));
    expect(host.querySelector<HTMLSelectElement>('#tool_reasoning_mode')?.disabled).toBe(true);
    expect(host.querySelector('#openrouter_interleaved_thinking_disabled_hint')).not.toBeNull();
});

test('a restore button sets the default', () => {
    const { host, sent } = mount(viewOf(), () => <CcUtility />);
    host.querySelector<HTMLElement>('#wi_format_restore')?.click();
    expect(sent.at(-1)).toEqual({ type: 'settings.reset', payload: { path: 'oai_settings.wi_format' } });
});

test('the slider sends the range; a level shows how many fields it sets', () => {
    const { host, sent } = mount(viewOf(), () => <LevelSlider />);
    expect(host.querySelector('[data-level="character"] .settings_level_count')?.textContent).toBe('3');
    const to = host.querySelector<HTMLInputElement>('#settings_level_to');
    if (!to) throw new Error('no slider');
    to.value = '4';
    to.dispatchEvent(new Event('change', { bubbles: true }));
    expect(sent.at(-1)).toEqual({ type: 'settings.range', payload: { from: 'default', to: 'character' } });
});

test('a view the server sends redraws the panel', () => {
    const { host, setCurrent } = mount(viewOf(), () => <CcSamplers />);
    setCurrent(viewOf({ values: { 'oai_settings.temp_openai': 0.4 } }));
    expect(host.querySelector<HTMLInputElement>('#temp_openai')?.value).toBe('0.4');
});

test("upstream's settings object reads the view and writes actions; a value already there isn't sent", async () => {
    const { client, sent, setCurrent } = stand(viewOf());
    const oai: Record<string, unknown> = { temp_openai: 0.9, custom_url: 'http://x' };
    createRoot(() => settingsCompat(client).bind(oai, 'oai_settings'));
    expect(oai['temp_openai']).toBe(1.2);
    oai['temp_openai'] = 1.2;
    expect(sent).toEqual([]);
    oai['temp_openai'] = 0.5;
    expect(sent).toEqual([{ type: 'settings.set', payload: { path: 'oai_settings.temp_openai', value: 0.5 } }]);
    expect(oai['temp_openai']).toBe(0.5);
    oai['custom_url'] = 'http://y';
    expect(oai['custom_url']).toBe('http://y');
    setCurrent(viewOf({ values: { 'oai_settings.temp_openai': 0.5 } }));
    await Promise.resolve();
    expect(oai['temp_openai']).toBe(0.5);
    expect(JSON.parse(JSON.stringify(oai))).toMatchObject({ temp_openai: 0.5 });
});

test('a refused write reads as the view again once the server answers', async () => {
    const { client } = stand(viewOf(), { ok: false, error: 'no' });
    const oai: Record<string, unknown> = { temp_openai: 0.9 };
    createRoot(() => settingsCompat(client).bind(oai, 'oai_settings'));
    oai['temp_openai'] = 7;
    expect(oai['temp_openai']).toBe(7);
    await Promise.resolve();
    await Promise.resolve();
    expect(oai['temp_openai']).toBe(1.2);
});

test('a watch runs when its paths change in the view, not for the first', () => {
    const { client, setCurrent } = stand(viewOf());
    let runs = 0;
    settingsCompat(client).watch(['oai_settings.openai_max_context'], () => runs++);
    setCurrent(viewOf({ values: { 'oai_settings.temp_openai': 0.3 } }));
    expect(runs).toBe(0);
    setCurrent(viewOf({ values: { 'oai_settings.openai_max_context': 9000 } }));
    expect(runs).toBe(1);
});

const textgen = (over: Partial<SettingsView> = {}) =>
    viewOf({
        api: { main: 'textgenerationwebui', source: 'openai', textgen: 'llamacpp' },
        values: {
            'textgenerationwebui_settings.temp': 0.7,
            'textgenerationwebui_settings.top_a': 0,
            'textgenerationwebui_settings.min_p': 0,
            'textgenerationwebui_settings.json_schema': null,
        },
        ...over,
    });

test("a text generation field shows for its backends; the user's chosen samplers decide over that", () => {
    const { host, setCurrent } = mount(textgen(), () => <TgSamplers />);
    expect(host.querySelector('#temp_textgenerationwebui')).not.toBeNull();
    expect(host.querySelector('#top_a_textgenerationwebui')).toBeNull();
    setCurrent(textgen({ samplerSelects: { llamacpp: { manual: true, shown: ['top_a'] } } }));
    expect(host.querySelector('#top_a_textgenerationwebui')).not.toBeNull();
    expect(host.querySelector('#temp_textgenerationwebui')).toBeNull();
    setCurrent(textgen({ samplerSelects: { llamacpp: { manual: false, shown: ['top_a'] } } }));
    expect(host.querySelector('#top_a_textgenerationwebui')).toBeNull();
});

test('with zen sliders a slider shows its value in its handle, Off at its off value', () => {
    const { host, setCurrent } = mount(textgen({ zen: true }), () => <TgSamplers />);
    expect(host.querySelector('#temp_textgenerationwebui_zenslider .ui-slider-handle')?.textContent).toBe('0.70');
    expect(host.querySelector('#min_p_textgenerationwebui_zenslider .ui-slider-handle')?.textContent).toBe('Off');
    expect(host.querySelector<HTMLInputElement>('#temp_textgenerationwebui')?.value).toBe('0.7');
    setCurrent(textgen({ zen: false }));
    expect(host.querySelector('#temp_textgenerationwebui_zenslider')).toBeNull();
    expect(host.querySelector('#temp_counter_textgenerationwebui')).not.toBeNull();
});

test('neutralize is one action', () => {
    const { host, sent } = mount(textgen(), () => <TgTop />);
    host.querySelector<HTMLElement>('#samplerResetButton')?.click();
    expect(sent).toEqual([{ type: 'settings.neutralize', payload: {} }]);
});

test("a JSON schema is sent parsed; text that isn't JSON isn't sent and stays", async () => {
    const { host, sent } = mount(textgen(), () => <TgSamplers />);
    const area = host.querySelector<HTMLTextAreaElement>('#tabby_json_schema');
    if (!area) throw new Error('no schema');
    area.value = '{ "type": "object" ';
    area.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(sent).toEqual([]);
    expect(area.value).toBe('{ "type": "object" ');
    area.value = '{ "type": "object" }';
    area.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(sent).toEqual([
        {
            type: 'settings.set',
            payload: { path: 'textgenerationwebui_settings.json_schema', value: { type: 'object' } },
        },
    ]);
});

test("the shared lengths show for the text APIs, each API's streaming under the response length", () => {
    const view = (main: string) =>
        viewOf({
            api: { main, source: 'openai', textgen: 'llamacpp' },
            values: { amount_gen: 300, max_context: 4096, 'power_user.max_context_unlocked': false },
        });
    const { host, setCurrent } = mount(view('kobold'), () => <CommonLengths />);
    expect(host.querySelector<HTMLInputElement>('#amount_gen_counter')?.value).toBe('300');
    expect(host.querySelector('#streaming_kobold')).not.toBeNull();
    expect(host.querySelector('#streaming_novel')).toBeNull();
    setCurrent(view('novel'));
    expect(host.querySelector('#streaming_novel')).not.toBeNull();
    setCurrent(view('openai'));
    expect(host.querySelector('#amount_gen')).toBeNull();
});
