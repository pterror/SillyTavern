import { characterFieldBaseline, getCurrentCharacter, getCurrentChatId, saveCharacterField, saveMetadata, saveSettingsDebounced, substituteParams } from '../../../script.js';
import { name1 } from '../../app-selection-state.js';
import { chat, chat_metadata } from '../../chat-state.js';
import { selected_group } from '../../group-chats.js';
import { t } from '../../i18n.js';
import { newUi } from '../../new-ui-page.js';
import { getOrCreatePersonaDescriptor, getPersonaDescriptionLorebook, setPersonaDescription, user_avatar } from '../../personas.js';
import { personaStore } from '../../power-user.js';
import { getRequestHeaders } from '../../request-headers.js';
import { findTagsByNames, readTagsForIds } from '../../tags.js';
import { findCharAsync, getCharaFilename, isFalseBoolean, isTrueBoolean, logSlashCommandWarn, onlyUnique, parseStringArray, uuidv4 } from '../../utils.js';
import { newWorldInfoEntryDefinition } from '../../world-info-entry-defaults.js';
import { extraBooksOf, METADATA_KEY, sendAuxBooksOp, setChatWorld, setWorldInfoButtonClass, updateCharacterWorldButton, worldNames, worlds } from '../../world-links.js';
import { SlashCommand } from '../SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../SlashCommandArgument.js';
import { commonEnumProviders, enumIcons } from '../SlashCommandCommonEnumsProvider.js';
import { SlashCommandEnumValue, enumTypes } from '../SlashCommandEnumValue.js';
import { SlashCommandParser } from '../SlashCommandParser.js';

const TIMED_EFFECTS = ['sticky', 'cooldown'];

/**
 * @param {string} path
 * @param {unknown} body
 * @returns {Promise<{ ok: boolean, status: number, answer: any }>}
 */
async function post(path, body) {
    const response = await fetch(`/api/worldinfo/${path}`, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(body) });
    return { ok: response.ok, status: response.status, answer: await response.json().catch(() => ({})) };
}

/**
 * @param {string} callbackName
 * @param {Record<string, unknown>} args
 * @param {Record<string, any> | null} unnamed
 * @param {string} message
 */
function warn(callbackName, args, unnamed, message) {
    toastr.warning(message);
    logSlashCommandWarn(`${callbackName}: ${message}`, args, unnamed);
}

/**
 * @param {string} file
 * @param {string} uid
 * @param {{ args: Record<string, unknown>, unnamed: Record<string, any> | null, callbackName: string }} asked
 * @returns {Promise<{ entry: Record<string, any>, hash: number } | null>}
 */
async function readEntry(file, uid, { args, unnamed, callbackName }) {
    if (!file || !worldNames().includes(file)) {
        warn(callbackName, args, unnamed, t`Valid World Info file name is required`);
        return null;
    }
    const read = await post('entry/get', { name: file, uid });
    if (read.status === 404) {
        warn(callbackName, args, unnamed, t`Valid UID is required`);
        return null;
    }
    if (!read.ok) {
        toastr.error(t`The entry could not be read. Check the server connection and try again.`);
        return null;
    }
    return read.answer;
}

/**
 * @param {unknown} possibleName
 * @param {string} fallbackName
 * @returns {Promise<string>}
 */
async function createWorldWithName(possibleName, fallbackName) {
    const hasExplicitName = typeof possibleName === 'string';
    const made = await post('create', { name: hasExplicitName ? possibleName : (fallbackName ?? `Lorebook (${uuidv4()})`), unique: !hasExplicitName });
    if (made.status === 409) throw new Error('This World Info file name is already in use');
    if (!made.ok) throw new Error('Failed to create World Info file');
    return String(made.answer.name);
}

/**
 * @param {string} name
 */
const generatedName = name => name.replace(/[^a-z0-9 -]/gi, '_').replace(/_{2,}/g, '_').substring(0, 64);

/**
 * @param {Record<string, any>} args
 * @param {string} text
 */
async function setWorldsCallback(args, text) {
    const silent = isTrueBoolean(String(args.silent));
    const said = (/** @type {boolean} */ ok, /** @type {string} */ message) => {
        if (!silent) (ok ? toastr.success : toastr.error)(message);
    };
    const known = worlds();
    if (known === null) {
        toastr.warning(t`The worlds are still loading. Try again in a moment.`);
        return '';
    }
    /** @type {{ book: string, used: boolean }[]} */
    const changes = [];
    /** @type {string[]} */
    const done = [];
    const asked = String(text ?? '').trim();
    if (asked === '') {
        changes.push(...known.filter(world => world.usedInEveryChat).map(world => ({ book: world.id, used: false })));
        done.push(t`Deactivated all worlds`);
    }
    for (const wanted of asked === '' ? [] : asked.split(',').map(name => name.trim()).filter(Boolean)) {
        const world = known.find(each => each.name.toLowerCase() === wanted.toLowerCase());
        if (!world) {
            said(false, t`No world found named: ${wanted}`);
            continue;
        }
        const before = [...changes].reverse().find(change => change.book === world.id)?.used ?? world.usedInEveryChat;
        const state = String(args.state ?? 'on').trim().toLowerCase();
        if (state === 'off' && !before) {
            said(false, t`World was not active: ${world.name}`);
            continue;
        }
        const used = state === 'off' ? false : state === 'toggle' ? !before : true;
        changes.push({ book: world.id, used });
        done.push(used ? t`Activated world: ${world.name}` : t`Deactivated world: ${world.name}`);
    }
    const refused = changes.length ? await newUi().worldbuilding.setUsedInEveryChat(changes) : null;
    if (refused) {
        toastr.error(refused);
        return '';
    }
    for (const message of done) said(true, message);
    return '';
}

async function getGlobalBooksCallback() {
    return JSON.stringify((worlds() ?? []).filter(world => world.usedInEveryChat).map(world => world.name));
}

/**
 * @param {Record<string, any>} args
 */
async function getChatBookCallback(args) {
    const chatId = getCurrentChatId();
    if (!chatId) {
        warn('getChatBookCallback', args, null, t`Open a chat to get a name of the chat-bound lorebook`);
        return '';
    }
    const linked = chat_metadata[METADATA_KEY];
    if (linked && worldNames().includes(linked)) return linked;
    if (isFalseBoolean(String(args.create))) return '';
    const name = await createWorldWithName(args.name, generatedName(`Chat Book ${chatId}`));
    await setChatWorld(name);
    return name;
}

/**
 * @param {Record<string, any>} args
 */
async function getPersonaBookCallback({ name, create }) {
    const bookName = getPersonaDescriptionLorebook();
    if (bookName) return bookName;
    if (!isTrueBoolean(String(create))) return '';
    const newName = await createWorldWithName(name, generatedName(`Persona Book ${name1}`));
    getOrCreatePersonaDescriptor();
    personaStore.update(user_avatar, { lorebook: newName });
    setPersonaDescription();
    saveSettingsDebounced('power_user.persona_data');
    return newName;
}

/**
 * @param {Record<string, any>} args
 * @param {string} characterIdentifier
 */
async function getCharBookCallback({ type, name, create }, characterIdentifier) {
    if (selected_group && !characterIdentifier) throw new Error('This command is not available in groups without providing a character name');
    type = String(type ?? '').trim().toLowerCase() || 'primary';
    const character = await findCharAsync({ name: String(characterIdentifier ?? '') || getCurrentCharacter()?.avatar || null });
    if (!character) {
        toastr.error(t`Character not found.`);
        logSlashCommandWarn('getCharBookCallback: Character not found', { type, name, create }, { characterIdentifier });
        return '';
    }
    const fileName = getCharaFilename(character.avatar);
    /** @type {string[]} */
    const books = [];
    if ((type === 'all' || type === 'primary') && character.data?.extensions?.world) books.push(character.data.extensions.world);
    if (type === 'all' || type === 'additional') books.push(...extraBooksOf(fileName).filter(Boolean));

    if (isTrueBoolean(String(create)) && books.length === 0) {
        const newName = await createWorldWithName(name, generatedName(`Character Book ${character.name}`));
        if (type === 'additional') {
            await sendAuxBooksOp(fileName, 'add', [newName]);
        } else {
            await saveCharacterField(character.avatar, '#character_world', newName, characterFieldBaseline(character, '#character_world'));
            if ($('#avatar_url_pole').val() === character.avatar) $('#character_world').val(newName);
        }
        setWorldInfoButtonClass(getCurrentCharacter()?.avatar);
        updateCharacterWorldButton();
        books.push(newName);
    }
    return type === 'primary' ? (books[0] ?? '') : JSON.stringify(books.filter(onlyUnique));
}

/**
 * @param {Record<string, any>} args
 * @param {string} text
 */
async function findBookEntryCallback(args, text) {
    const file = String(args.file ?? '');
    if (!file || !worldNames().includes(file)) {
        warn('findBookEntryCallback', args, { text }, t`Valid World Info file name is required`);
        return '';
    }
    const found = await post('entry/find', { name: file, field: args.field || 'key', text: String(text ?? '') });
    if (!found.ok) {
        warn('findBookEntryCallback', args, { text }, found.answer?.error ?? t`The entry could not be found.`);
        return '';
    }
    return found.answer.uid === null ? '' : String(found.answer.uid);
}

/**
 * @param {Record<string, any>} args
 * @param {string} uid
 */
async function getEntryFieldCallback(args, uid) {
    const field = args.field || 'content';
    const read = await readEntry(String(args.file ?? ''), String(uid ?? ''), { args, unnamed: { uid }, callbackName: 'getEntryFieldCallback' });
    if (!read) return '';
    if (!Object.hasOwn(newWorldInfoEntryDefinition, field)) {
        warn('getEntryFieldCallback', args, { uid }, t`Valid field name is required`);
        return '';
    }
    const { entry } = read;
    let fieldValue;
    switch (field) {
        case 'characterFilterNames':
            fieldValue = entry.characterFilter?.names;
            break;
        case 'characterFilterTags': {
            const ids = entry.characterFilter?.tags;
            if (!entry.characterFilter) break;
            if (!ids) return '';
            const tags = await readTagsForIds(ids);
            if (!tags) {
                toastr.error(t`The entry's tags could not be read. Check the server connection and try again.`);
                return '';
            }
            fieldValue = ids.map(id => tags.tags.get(id)?.name).filter(tagName => tagName !== undefined);
            break;
        }
        case 'characterFilterExclude':
            fieldValue = entry.characterFilter?.isExclude;
            break;
        default:
            fieldValue = entry[field] ?? newWorldInfoEntryDefinition[field]?.default;
    }
    if (fieldValue === undefined || fieldValue === null) return '';
    if (Array.isArray(fieldValue)) return JSON.stringify(fieldValue.map(x => substituteParams(x)));
    return substituteParams(String(fieldValue));
}

/**
 * @param {Record<string, any>} args
 * @param {string} content
 */
async function createEntryCallback(args, content) {
    const file = String(args.file ?? '');
    if (!file || !worldNames().includes(file)) {
        warn('createEntryCallback', args, null, t`Valid World Info file name is required`);
        return '';
    }
    const key = args.key ? String(args.key) : '';
    const data = {
        ...(key ? { key: [key], comment: key, addMemo: true } : {}),
        ...(content ? { content: String(content) } : {}),
    };
    const made = await post('entry/create', { name: file, data });
    if (!made.ok) {
        toastr.error(t`Failed to create a new World Info entry`);
        logSlashCommandWarn('createEntryCallback: Failed to create a new World Info entry', args);
        return '';
    }
    return String(made.answer.entry.uid);
}

/**
 * @param {string} field
 * @param {string} value
 * @returns {Promise<Record<string, unknown>>}
 */
async function fieldsToSet(field, value) {
    switch (field) {
        case 'characterFilterNames': {
            const found = await Promise.all(parseStringArray(value).map(name => findCharAsync({ name, allowAvatar: true, preferCurrentChar: false, quiet: true })));
            return { characterFilter: { names: found.map(character => getCharaFilename(character?.avatar)).filter(Boolean).filter(onlyUnique) } };
        }
        case 'characterFilterTags': {
            const names = parseStringArray(value);
            const found = await findTagsByNames(names);
            return { characterFilter: { tags: [...found.values()].filter(tag => tag && names.includes(tag.name)).map(tag => tag.id).filter(onlyUnique) } };
        }
        case 'characterFilterExclude':
            return { characterFilter: { isExclude: isTrueBoolean(value) } };
    }
    const { type, arrayFilter } = newWorldInfoEntryDefinition[field];
    if (type === 'array') return { [field]: parseStringArray(value).filter(arrayFilter ?? (() => true)) };
    if (type.startsWith('boolean')) return { [field]: isTrueBoolean(value) };
    if (type.startsWith('number') || type === 'enum') return { [field]: Number(value) };
    return { [field]: value };
}

/**
 * @param {Record<string, any>} args
 * @param {string} value
 */
async function setEntryFieldCallback(args, value) {
    const field = args.field || 'content';
    if (value === undefined) {
        warn('setEntryFieldCallback', args, { value }, t`Value is required`);
        return '';
    }
    const file = String(args.file ?? '');
    if (!file || !worldNames().includes(file)) {
        warn('setEntryFieldCallback', args, { value }, t`Valid World Info file name is required`);
        return '';
    }
    if (!Object.hasOwn(newWorldInfoEntryDefinition, field)) {
        warn('setEntryFieldCallback', args, { value }, t`Valid field name is required`);
        return '';
    }
    const fields = await fieldsToSet(field, value.replace(/\\([{}|])/g, '$1'));
    const set = await post('entry/set', { name: file, uid: String(args.uid ?? ''), fields });
    if (set.status === 404) {
        warn('setEntryFieldCallback', args, { value }, t`Valid UID is required`);
    } else if (!set.ok) {
        toastr.error(set.answer?.error ?? t`The entry was not changed.`);
    }
    return '';
}

/**
 * @returns {number}
 */
const scannedMessages = () => chat.filter(message => !message.is_system).length;

/**
 * @param {string} effect
 * @returns {boolean}
 */
const isTimedEffect = effect => typeof effect === 'string' && TIMED_EFFECTS.includes(effect.trim().toLowerCase());

/**
 * @param {Record<string, any>} args
 * @param {string} uid
 */
async function getTimedEffectCallback(args, uid) {
    if (!getCurrentChatId()) throw new Error('This command can only be used in chat');
    const file = String(args.file ?? '');
    const read = await readEntry(file, String(uid ?? ''), { args, unnamed: { uid }, callbackName: 'getTimedEffectCallback' });
    if (!read) return '';
    if (!isTimedEffect(args.effect)) {
        warn('getTimedEffectCallback', args, { uid }, t`Valid effect type is required`);
        return '';
    }
    const effect = chat_metadata.timedWorldInfo?.[args.effect.trim().toLowerCase()]?.[`${file}.${read.entry.uid ?? uid}`];
    if (String(args.format).trim().toLowerCase() === ARGUMENT_TYPE.NUMBER) {
        return String(effect ? (effect.end - scannedMessages()) : 0);
    }
    return String(!!effect);
}

/**
 * @param {Record<string, any>} args
 * @param {string} value
 */
async function setTimedEffectCallback(args, value) {
    if (!getCurrentChatId()) throw new Error('This command can only be used in chat');
    if (value === undefined) {
        warn('setTimedEffectCallback', args, { value }, t`New state is required`);
        return '';
    }
    const file = String(args.file ?? '');
    const read = await readEntry(file, String(args.uid ?? ''), { args, unnamed: { value }, callbackName: 'setTimedEffectCallback' });
    if (!read) return '';
    if (!isTimedEffect(args.effect)) {
        warn('setTimedEffectCallback', args, { value }, t`Valid effect type is required`);
        return '';
    }
    const type = args.effect.trim().toLowerCase();
    const { entry, hash } = read;
    if (!entry[type]) {
        warn('setTimedEffectCallback', args, { value }, t`This entry does not have the selected effect. Configure it in the editor first.`);
        return '';
    }
    chat_metadata.timedWorldInfo ??= {};
    const effects = chat_metadata.timedWorldInfo[type] ??= {};
    const key = `${file}.${entry.uid ?? args.uid}`;
    const now = !!effects[key];
    const asked = value.trim().toLowerCase();
    const next = ['toggle', 't', ''].includes(asked) ? !now : isTrueBoolean(value) ? true : isFalseBoolean(value) ? false : now;
    delete effects[key];
    if (next) {
        const start = scannedMessages();
        effects[key] = { hash, start, end: start + Number(entry[type]), protected: false };
    }
    await saveMetadata();
    toastr.success(t`Timed effect "${type}" for entry ${entry.uid} is now ${next ? 'active' : 'inactive'}`);
    return '';
}

const entryFields = () => Object.entries(newWorldInfoEntryDefinition).map(([key, value]) =>
    new SlashCommandEnumValue(key, `[${value.type}] default: ${(typeof value.default === 'string' ? `'${value.default}'` : JSON.stringify(value.default))}`,
        enumTypes.enum, enumIcons.getDataTypeIcon(value.type)));

const timedEffects = () => [
    new SlashCommandEnumValue('sticky', 'Stays active for N messages', enumTypes.enum, '📌'),
    new SlashCommandEnumValue('cooldown', 'Cooldown for N messages', enumTypes.enum, '⌛'),
];

const bookArgument = () => SlashCommandNamedArgument.fromProps({
    name: 'file',
    description: 'book name',
    typeList: [ARGUMENT_TYPE.STRING],
    isRequired: true,
    enumProvider: commonEnumProviders.worlds,
});

const createArgument = (/** @type {string} */ defaultValue) => SlashCommandNamedArgument.fromProps({
    name: 'create',
    description: 'create a new lorebook if it doesn\'t exist',
    typeList: [ARGUMENT_TYPE.BOOLEAN],
    isRequired: false,
    acceptsMultiple: false,
    enumList: commonEnumProviders.boolean('trueFalse')(),
    defaultValue,
});

const newBookNameArgument = () => SlashCommandNamedArgument.fromProps({
    name: 'name',
    description: 'lorebook name if creating a new one, will be auto-generated otherwise',
    typeList: [ARGUMENT_TYPE.STRING],
    isRequired: false,
    acceptsMultiple: false,
});

export function registerWorldInfoCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'world',
        callback: setWorldsCallback,
        namedArgumentList: [
            new SlashCommandNamedArgument('state', 'set world state', [ARGUMENT_TYPE.STRING], false, false, null, commonEnumProviders.boolean('onOffToggle')()),
            new SlashCommandNamedArgument('silent', 'suppress toast messages', [ARGUMENT_TYPE.BOOLEAN], false),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'world name',
                typeList: [ARGUMENT_TYPE.STRING],
                enumProvider: commonEnumProviders.worlds,
            }),
        ],
        helpString: `
            <div>
                Sets active World, or unsets if no args provided, use <code>state=off</code> and <code>state=toggle</code> to deactivate or toggle a World, use <code>silent=true</code> to suppress toast messages.
            </div>
        `,
        aliases: [],
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'getchatbook',
        callback: getChatBookCallback,
        returns: 'lorebook name',
        helpString: 'Get a name of the chat-bound lorebook or create a new one if was unbound, and pass it down the pipe.',
        namedArgumentList: [newBookNameArgument(), createArgument('true')],
        aliases: ['getchatlore', 'getchatwi'],
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'getglobalbooks',
        callback: getGlobalBooksCallback,
        returns: 'list of selected lorebook names',
        helpString: 'Get a list of names of the selected global lorebooks and pass it down the pipe.',
        aliases: ['getgloballore', 'getglobalwi'],
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'getpersonabook',
        callback: getPersonaBookCallback,
        returns: 'lorebook name',
        namedArgumentList: [newBookNameArgument(), createArgument('false')],
        helpString: 'Get a name of the current persona-bound lorebook and pass it down the pipe. Returns empty string if persona lorebook is not set.',
        aliases: ['getpersonalore', 'getpersonawi'],
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'getcharbook',
        callback: getCharBookCallback,
        returns: 'lorebook name or a list of lorebook names',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'type',
                description: 'type of the lorebook to get, returns a list for "all" and "additional"',
                typeList: [ARGUMENT_TYPE.STRING],
                enumList: ['primary', 'additional', 'all'],
                defaultValue: 'primary',
            }),
            newBookNameArgument(),
            createArgument('false'),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Character name - or unique character identifier (avatar key). If not provided, the current character is used.',
                typeList: [ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.STRING],
                isRequired: false,
                enumProvider: commonEnumProviders.characters('character'),
            }),
        ],
        helpString: 'Get a name of the character-bound lorebook and pass it down the pipe. Returns empty string if character lorebook is not set. Does not work in group chats without providing a character avatar name.',
        aliases: ['getcharlore', 'getcharwi'],
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'findentry',
        aliases: ['findlore', 'findwi'],
        returns: 'UID',
        callback: findBookEntryCallback,
        namedArgumentList: [
            bookArgument(),
            SlashCommandNamedArgument.fromProps({
                name: 'field',
                description: 'the field to search (default: key)',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'key',
                enumList: ['key', 'comment', 'content', 'group', 'keysecondary', 'automationId', 'uid'],
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument('texts', ARGUMENT_TYPE.STRING, true, true),
        ],
        helpString: `
            <div>
                Find the UID of the first entry in the specified book whose field (default: key) matches the words, the way the world's search matches them, and pass it down the pipe.
            </div>
            <div>
                <strong>Example:</strong>
                <ul>
                    <li>
                        <pre><code>/findentry file=chatLore field=key Shadowfang</code></pre>
                    </li>
                </ul>
            </div>
        `,
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'getentryfield',
        aliases: ['getlorefield', 'getwifield'],
        callback: getEntryFieldCallback,
        returns: 'field value',
        namedArgumentList: [
            bookArgument(),
            SlashCommandNamedArgument.fromProps({
                name: 'field',
                description: 'field to retrieve (default: content)',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'content',
                enumList: entryFields(),
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'record UID',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
        ],
        helpString: `
            <div>
                Get a field value (default: content) of the record with the UID from the specified book and pass it down the pipe.
            </div>
            <div>
                <strong>Example:</strong>
                <ul>
                    <li>
                        <pre><code>/getentryfield file=chatLore field=content 123</code></pre>
                    </li>
                </ul>
            </div>
        `,
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'createentry',
        callback: createEntryCallback,
        aliases: ['createlore', 'createwi'],
        returns: 'UID of the new record',
        namedArgumentList: [
            bookArgument(),
            new SlashCommandNamedArgument('key', 'record key', [ARGUMENT_TYPE.STRING], false),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument('content', [ARGUMENT_TYPE.STRING], false),
        ],
        helpString: `
            <div>
                Create a new record in the specified book with the key and content (both are optional) and pass the UID down the pipe.
            </div>
            <div>
                <strong>Example:</strong>
                <ul>
                    <li>
                        <pre><code>/createentry file=chatLore key=Shadowfang The sword of the king</code></pre>
                    </li>
                </ul>
            </div>
        `,
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'setentryfield',
        callback: setEntryFieldCallback,
        aliases: ['setlorefield', 'setwifield'],
        namedArgumentList: [
            bookArgument(),
            SlashCommandNamedArgument.fromProps({
                name: 'uid',
                description: 'record UID',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'field',
                description: 'field name (default: content)',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'content',
                enumList: entryFields(),
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument('value', [ARGUMENT_TYPE.STRING], true),
        ],
        helpString: `
            <div>
                Set a field value (default: content) of the record with the UID from the specified book. To set multiple values for key fields, use comma-delimited list as a value.
            </div>
            <div>
                <strong>Example:</strong>
                <ul>
                    <li>
                        <pre><code>/setentryfield file=chatLore uid=123 field=key Shadowfang,sword,weapon</code></pre>
                    </li>
                </ul>
            </div>
        `,
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'wi-set-timed-effect',
        callback: setTimedEffectCallback,
        namedArgumentList: [
            bookArgument(),
            SlashCommandNamedArgument.fromProps({
                name: 'uid',
                description: 'record UID',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'effect',
                description: 'effect name',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: timedEffects,
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'new state of the effect',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                acceptsMultiple: false,
                enumList: commonEnumProviders.boolean('onOffToggle')(),
            }),
        ],
        helpString: `
            <div>
                Set a timed effect for the record with the UID from the specified book. The duration must be set in the entry itself.
                Will only be applied for the current chat. Enabling an effect that was already active refreshes the duration.
                If the last chat message is swiped or deleted, the effect will be removed.
            </div>
            <div>
                <strong>Example:</strong>
                <ul>
                    <li>
                        <pre><code>/wi-set-timed-effect file=chatLore uid=123 effect=sticky on</code></pre>
                    </li>
                </ul>
            </div>
        `,
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'wi-get-timed-effect',
        callback: getTimedEffectCallback,
        helpString: `
            <div>
                Get the current state of the timed effect for the record with the UID from the specified book.
            </div>
            <div>
                <strong>Example:</strong>
                <ul>
                    <li>
                        <code>/wi-get-timed-effect file=chatLore format=bool effect=sticky 123</code> - returns true or false if the effect is active or not
                    </li>
                    <li>
                        <code>/wi-get-timed-effect file=chatLore format=number effect=sticky 123</code> - returns the remaining duration of the effect, or 0 if inactive
                    </li>
                </ul>
            </div>
        `,
        returns: 'state of the effect',
        namedArgumentList: [
            bookArgument(),
            SlashCommandNamedArgument.fromProps({
                name: 'effect',
                description: 'effect name',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: timedEffects,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'format',
                description: 'output format',
                isRequired: false,
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: ARGUMENT_TYPE.BOOLEAN,
                enumList: [ARGUMENT_TYPE.BOOLEAN, ARGUMENT_TYPE.NUMBER],
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'record UID',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
        ],
    }));
}
