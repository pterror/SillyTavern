import { start } from '/ui/entry.js';
import { newUi, newUiStarted, setNewUi } from './new-ui-page.js';
import { getRequestHeaders } from './request-headers.js';
import { attachNewPage } from './tab-session.js';
import { translate } from './i18n.js';
import { eventSource, event_types } from './events.js';
import { SlashCommand } from './slash-commands/SlashCommand.js';
import { SlashCommandParser } from './slash-commands/SlashCommandParser.js';

/**
 * @param {{ quietPrompt: (prompt: string) => Promise<string>, currentChat: () => ({ avatar: string } | { group: string } | null), alternatives: import('/ui/entry.js').StartOptions['alternatives'] }} options
 */
export function startNewUi({ quietPrompt, currentChat, alternatives }) {
    if (newUiStarted()) return newUi();
    const element = (/** @type {string} */ id) => {
        const found = document.getElementById(id);
        if (!found) throw new Error(`The new page's container #${id} is missing`);
        return found;
    };
    const started = start({
        headers: () => getRequestHeaders(),
        t: (text, key) => translate(text, key ?? null),
        quietPrompt,
        currentChat,
        alternatives,
        containers: {
            backgrounds: element('Backgrounds'),
            backgroundLayer: element('bg1'),
            backgroundAnimation: element('background_animation_option'),
            settingsLevels: element('settings_levels'),
            ccContext: element('cc_context_fields'),
            ccSamplers: element('cc_sampler_fields'),
            ccUtility: element('cc_utility_fields'),
            ccOptions: element('cc_option_fields'),
            commonLengths: element('common_length_fields'),
            tgTop: element('tg_top_fields'),
            tgSamplers: element('tg_sampler_fields'),
            tgCfg: element('tg_cfg_fields'),
        },
    });
    setNewUi(started);
    const page = started;
    attachNewPage({ views: views => page.receive({ type: 'views', views }), connected: () => void page.reconnected() });
    const backgrounds = started.backgrounds;
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

export { newUi, newUiStarted };

/**
 * @param {import('/ui/entry.js').ViewFrame[] | undefined} views
 */
export function takeViews(views) {
    if (newUiStarted() && Array.isArray(views) && views.length) newUi().receive({ type: 'views', views });
}

export function chatClosed() {
    if (newUiStarted()) void newUi().closeChat();
}
