import { start } from '/ui/entry.js';

/** The settings paths the server owns: the new page shows them, and the old page neither writes nor saves them. */
export { SERVER_OWNED } from '/ui/entry.js';
import { getRequestHeaders } from './request-headers.js';
import { attachNewPage } from './tab-session.js';
import { translate } from './i18n.js';
import { eventSource, event_types } from './events.js';
import { SlashCommand } from './slash-commands/SlashCommand.js';
import { SlashCommandParser } from './slash-commands/SlashCommandParser.js';

/**
 * Starts the new page (packages/ui) inside this one: it gets what only the old page has yet (the request headers,
 * the translations, the quiet prompt), and the containers its surfaces replace. Old code reaches the new page
 * through here (and the stubs at upstream's old paths, which use it); nothing new imports old code.
 */

/** @type {import('/ui/entry.js').NewUi | null} */
let started = null;

/**
 * Starts it, once the page's DOM and the old modules it calls into are ready (script.js's init).
 * @param {{ quietPrompt: (prompt: string) => Promise<string>, currentChat: () => ({ avatar: string } | { group: string } | null) }} options
 */
export function startNewUi({ quietPrompt, currentChat }) {
    if (started) return started;
    const element = (/** @type {string} */ id) => {
        const found = document.getElementById(id);
        if (!found) throw new Error(`The new page's container #${id} is missing`);
        return found;
    };
    started = start({
        headers: () => getRequestHeaders(),
        t: (text, key) => translate(text, key ?? null),
        quietPrompt,
        currentChat,
        containers: {
            backgrounds: element('Backgrounds'),
            backgroundLayer: element('bg1'),
            backgroundAnimation: element('background_animation_option'),
            settingsLevels: element('settings_levels'),
            ccContext: element('cc_context_fields'),
            ccSamplers: element('cc_sampler_fields'),
            ccUtility: element('cc_utility_fields'),
            ccOptions: element('cc_option_fields'),
            tgTop: element('tg_top_fields'),
            tgSamplers: element('tg_sampler_fields'),
            tgCfg: element('tg_cfg_fields'),
        },
    });
    const page = started;
    attachNewPage({ views: views => page.receive({ type: 'views', views }), connected: () => void page.reconnected() });
    const backgrounds = started.backgrounds;
    // Image generation's "set as background" (and extensions that emit it).
    eventSource.on(event_types.FORCE_SET_BACKGROUND, (/** @type {{ path: string }} */ background) => void backgrounds.forceSetBackground(background));
    const say = (/** @type {Promise<string | null>} */ refused) => refused.then(reason => {
        if (reason) toastr.warning(reason);
        return '';
    });
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'lockbg',
        callback: () => say(backgrounds.lock()),
        aliases: ['bglock'],
        helpString: 'Locks a background for the currently selected chat',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'unlockbg',
        callback: () => say(backgrounds.unlock()),
        aliases: ['bgunlock'],
        helpString: 'Unlocks a background for the currently selected chat',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'autobg',
        callback: () => say(backgrounds.autoSelect()),
        aliases: ['bgauto'],
        helpString: 'Automatically changes the background based on the chat context using the AI request prompt',
    }));
    return started;
}

/** Whether script.js's init started the new page yet. */
export const newUiStarted = () => started !== null;

/** The started new page; old code calls in only after script.js's init started it. */
export function newUi() {
    if (!started) throw new Error('The new page is not started yet');
    return started;
}

/**
 * Views the server sent with an old route's answer (before the start there are none: views only follow the new
 * page's own asking).
 * @param {import('/ui/entry.js').ViewFrame[] | undefined} views
 */
export function takeViews(views) {
    if (started && Array.isArray(views) && views.length) started.receive({ type: 'views', views });
}

/** The chat closed on this page (no chat shows): the new page's views that follow the chat are read for none. */
export function chatClosed() {
    void started?.closeChat();
}
