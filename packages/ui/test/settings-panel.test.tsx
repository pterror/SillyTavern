import { createRoot, createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { expect, test } from 'vite-plus/test';
import { FIELDS } from '@st/protocol/settings';
import type { SettingsView } from '@st/protocol/settings';
import type { Client } from '../src/client.ts';
import { UiProvider } from '../src/context.ts';
import { LevelSlider, SettingsPanel, isShown } from '../src/areas/settings/Panel.tsx';

// The panel against a stand-in client: it draws the view it's given and sends what the user does.

function viewOf(over: Partial<SettingsView> = {}): SettingsView {
    return {
        context: { avatar: 'cara.png' },
        range: { from: 'default', to: 'user' },
        values: { 'oai_settings.temp_openai': 1.2, 'oai_settings.names_behavior': 0 },
        sources: { 'oai_settings.temp_openai': 'user' },
        counts: { user: 1, character: 3 },
        ranges: {},
        api: { main: 'openai', source: 'openai', textgen: '' },
        ...over,
    };
}

function mount(view: SettingsView, answer: { ok: true } | { ok: false; error: string } = { ok: true }) {
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
    };
    const host = document.createElement('div');
    document.body.append(host);
    createRoot(() =>
        render(
            () => (
                <UiProvider value={{ client, t: (text) => text }}>
                    <LevelSlider />
                    <SettingsPanel family="cc" />
                </UiProvider>
            ),
            host,
        ),
    );
    return { host, sent, setCurrent };
}

const field = (id: string) => {
    const found = FIELDS.find((f) => f.id === id);
    if (!found) throw new Error(id);
    return found;
};

test('a field shows for the sources, backends and APIs it names', () => {
    const api = { main: 'openai', source: 'claude', textgen: 'llamacpp' };
    expect(isShown(field('temp_openai'), api)).toBe(true);
    expect(isShown(field('freq_pen_openai'), api)).toBe(false);
    expect(isShown(field('dry_multiplier_textgenerationwebui'), api)).toBe(true);
    expect(isShown(field('top_k_textgenerationwebui'), { ...api, textgen: 'generic' })).toBe(false);
    expect(isShown(field('amount_gen'), api)).toBe(false);
});

test('each field is drawn with its value, under its old id, colored by the level it comes from', () => {
    const { host } = mount(viewOf());
    const temp = host.querySelector<HTMLInputElement>('#temp_openai');
    expect(temp?.value).toBe('1.2');
    expect(temp?.closest('[data-settings-level]')?.getAttribute('data-settings-level')).toBe('user');
    // A source that hides it: not drawn.
    expect(host.querySelector('#freq_pen_openai')).not.toBeNull();
    expect(host.querySelector('#top_k_textgenerationwebui')).toBeNull();
});

test('a range above the defaults dims what no level in it sets', () => {
    const { host } = mount(viewOf({ range: { from: 'user', to: 'character' }, sources: {} }));
    expect(
        host.querySelector('#temp_openai')?.closest('[data-settings-level]')?.getAttribute('data-settings-level'),
    ).toBe('unset');
});

test("an edit is sent as the field's value; a refused one goes back and says why", async () => {
    const { host, sent } = mount(viewOf(), { ok: false, error: 'Temperature: at most 2' });
    const temp = host.querySelector<HTMLInputElement>('#temp_openai');
    if (!temp) throw new Error('no control');
    temp.value = '1.9';
    temp.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toEqual([{ type: 'settings.set', payload: { path: 'oai_settings.temp_openai', value: 1.9 } }]);
    expect(temp.value).toBe('1.2');
    expect(host.querySelector('.settings_refusal')?.textContent).toBe('Temperature: at most 2');
});

test('a choice is its radios, under their old ids, one checked', () => {
    const { host, sent } = mount(viewOf());
    const radio = host.querySelector<HTMLInputElement>('#character_names_completion');
    expect(host.querySelector<HTMLInputElement>('#character_names_default')?.checked).toBe(true);
    radio?.click();
    expect(sent.at(-1)).toEqual({ type: 'settings.set', payload: { path: 'oai_settings.names_behavior', value: 1 } });
});

test('the slider sends the range; a level shows how many fields it sets', () => {
    const { host, sent } = mount(viewOf());
    expect(host.querySelector('[data-level="character"] .settings_level_count')?.textContent).toBe('3');
    const to = host.querySelector<HTMLInputElement>('#settings_level_to');
    if (!to) throw new Error('no slider');
    to.value = '4';
    to.dispatchEvent(new Event('change', { bubbles: true }));
    expect(sent.at(-1)).toEqual({ type: 'settings.range', payload: { from: 'default', to: 'character' } });
});

test('a view the server sends redraws the panel', () => {
    const { host, setCurrent } = mount(viewOf());
    setCurrent(viewOf({ values: { 'oai_settings.temp_openai': 0.4 } }));
    expect(host.querySelector<HTMLInputElement>('#temp_openai')?.value).toBe('0.4');
});
