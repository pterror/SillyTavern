import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';

jest.unstable_mockModule('../public/scripts/request-headers.js', () => ({ getRequestHeaders: () => ({}) }));

/** @type {typeof import('../public/scripts/macro-values.js')} */
let values;
/** @type {{ body: any, answer: (values: (string | null)[]) => void }[]} */
let asked = [];
let heard = 0;

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

beforeAll(async () => {
    globalThis.fetch = /** @type {any} */ (async (/** @type {string} */ _url, /** @type {any} */ init) => {
        const body = JSON.parse(init.body);
        const answered = await new Promise(resolve => asked.push({ body, answer: resolve }));
        return { ok: true, headers: { get: () => null }, json: async () => ({ values: answered }) };
    });
    values = await import('../public/scripts/macro-values.js');
    values.onMacroValuesChanged(() => heard++);
});

beforeEach(async () => {
    values.replaceMacroValues(undefined);
    await settle();
    asked = [];
    heard = 0;
});

const ada = { avatar_url: 'Ada.png' };

describe('the page\'s macro values', () => {
    test('are a scope\'s: every view of the same character and speaker reads them, wherever the chat is read up to', () => {
        values.takeMacroValues(ada, [{ speaker: null, values: { '{{user}}': 'Me' } }, { speaker: 'Ada', values: { '{{char}}': 'Ada' } }]);
        const person = new values.MacroValues(() => ({ ...ada, at: 'n1' }));
        const elsewhere = new values.MacroValues(() => ({ ...ada, at: 'n2' }));
        const speaker = new values.MacroValues(() => ({ ...ada, name2: 'Ada' }));
        expect(person.get('{{user}}')).toBe('Me');
        expect(elsewhere.get('{{user}}')).toBe('Me');
        expect(speaker.get('{{user}}')).toBeUndefined();
        expect(speaker.get('{{char}}')).toBe('Ada');
        expect(new values.MacroValues(() => ({ group_id: 'g' })).get('{{user}}')).toBeUndefined();
    });

    test('a value a drawing reads and nobody has is asked for once, with the others read in the same moment', async () => {
        const view = new values.MacroValues(() => ({ ...ada, at: 'n1', name2: 'Ada' }));
        expect(view.read('{{user}}')).toBeUndefined();
        expect(view.read('{{char}}')).toBeUndefined();
        expect(view.read('{{user}}')).toBeUndefined();
        await settle();
        expect(asked.map(each => each.body.macros)).toEqual([['{{user}}', '{{persona}}', '{{char}}', '{{charCreatorNotes}}']]);
        expect(asked[0].body).toMatchObject({ avatar_url: 'Ada.png', at: 'n1', name2: 'Ada' });
        const version = view.version();
        asked[0].answer(['Me', '', 'Ada', '']);
        await settle();
        expect([view.get('{{user}}'), view.get('{{char}}')]).toEqual(['Me', 'Ada']);
        expect(view.version()).toBeGreaterThan(version);
        expect(heard).toBe(1);
    });

    test('an action that may change every value is answered with every one held, each in its scope; one not answered is dropped', async () => {
        values.takeMacroValues(ada, [{ speaker: null, values: { '{{user}}': 'Me' } }, { speaker: 'Ada', values: { '{{user}}': 'Me', '{{time}}': 'noon' } }]);
        values.takeScopeMacroValues({ avatar_url: 'Bo.png' }, { '{{user}}': 'Me' });
        expect(values.heldMacroSources()).toEqual([
            { avatar_url: 'Ada.png', speaker: null, sources: ['{{user}}'] },
            { avatar_url: 'Ada.png', speaker: 'Ada', sources: ['{{user}}', '{{time}}'] },
            { avatar_url: 'Bo.png', speaker: null, sources: ['{{user}}'] },
        ]);
        const person = new values.MacroValues(() => ada);
        const speaker = new values.MacroValues(() => ({ ...ada, name2: 'Ada' }));
        const other = new values.MacroValues(() => ({ avatar_url: 'Bo.png' }));
        const [personWas, speakerWas] = [person.version(), speaker.version()];
        values.replaceMacroValues([{ ...ada, speaker: null, values: { '{{user}}': 'Me' } }, { ...ada, speaker: 'Ada', values: { '{{user}}': 'You', '{{time}}': 'noon' } }]);
        expect(person.version()).toBe(personWas);
        expect(speaker.version()).toBeGreaterThan(speakerWas);
        expect(speaker.get('{{user}}')).toBe('You');
        expect(other.get('{{user}}')).toBeUndefined();
    });

    test('a question asked before such an action is answered into nothing, and asked again by whoever draws it', async () => {
        const view = new values.MacroValues(() => ada);
        expect(view.read('{{user}}')).toBeUndefined();
        await settle();
        values.replaceMacroValues([{ ...ada, speaker: null, values: {} }]);
        await settle();
        expect(heard).toBe(1);
        asked[0].answer(['Stale', '']);
        await settle();
        expect(view.get('{{user}}')).toBeUndefined();
        expect(view.read('{{user}}')).toBeUndefined();
        await settle();
        expect(asked).toHaveLength(2);
        asked[1].answer(['Fresh', '']);
        await settle();
        expect(view.get('{{user}}')).toBe('Fresh');
    });

    test('a refresh after an edit asks again only for the edited text\'s macros the page holds', async () => {
        values.takeMacroValues(ada, [{ speaker: null, values: { '{{user}}': 'Me', '{{description}}': 'Tall' } }]);
        const view = new values.MacroValues(() => ada);
        const refreshed = view.refresh(['{{user}}', '{{unheld}}']);
        await settle();
        expect(asked.map(each => each.body.macros)).toEqual([['{{user}}']]);
        asked[0].answer(['You']);
        expect(await refreshed).toBe(true);
        expect([view.get('{{user}}'), view.get('{{description}}')]).toEqual(['You', 'Tall']);
    });
});
