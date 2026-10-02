/**
 * The help panel: every help topic in one place, with a topic list (a sidebar on wide screens, behind a menu button
 * on narrow ones) and a search box that searches all topics at once. It is a layer, not a modal: the chat and the
 * drawers stay usable while it's open.
 */
import { openEditorLayer } from './editor-layer.js';
import { raiseDrawer, updateDrawerStack } from './drawer-stack.js';
import { findHelpTopic, getHelpTopics, registerHelpTopic } from './help-registry.js';
import { t } from './i18n.js';
import { MacroBrowser } from './macros/engine/MacroBrowser.js';
import { SlashCommandBrowser } from './slash-commands/SlashCommandBrowser.js';
import { renderTemplateAsync } from './templates.js';
import { debounce } from './utils.js';

export const DEFAULT_HELP_TOPIC = 'overview';

/** Upstream's `/help` names and numbers, kept so every `/help <name>` that worked there opens the same topic. */
const BUILT_IN_TOPICS = [
    { id: 'overview', title: () => t`Overview`, aliases: ['help'], order: 10, render: templateTopic('help') },
    { id: 'slash', title: () => t`Slash Commands`, aliases: ['commands', 'slashes', 'slash commands', '1'], order: 20, render: renderSlashCommands },
    { id: 'format', title: () => t`Formatting`, aliases: ['formatting', 'formats', 'chat formatting', '2'], order: 30, render: templateTopic('formatting') },
    { id: 'hotkeys', title: () => t`Hotkeys`, aliases: ['hotkey', '3'], order: 40, render: templateTopic('hotkeys') },
    { id: 'macros', title: () => t`Macros`, aliases: ['macro', '4'], order: 50, render: renderMacros },
];
for (const topic of BUILT_IN_TOPICS) {
    registerHelpTopic({ ...topic, title: topic.title() });
}

/**
 * @param {string} templateId
 * @returns {(container: HTMLElement, query: string) => Promise<number | void>}
 */
function templateTopic(templateId) {
    return async (container, query) => {
        container.insertAdjacentHTML('beforeend', await renderTemplateAsync(templateId));
        if (query) return keepMatchingLines(container, query);
    };
}

/**
 * Leaves only the lines of a help page that contain `query` (ignoring case), plus the headings above them.
 * @param {HTMLElement} container
 * @param {string} query
 * @returns {number} How many lines matched.
 */
function keepMatchingLines(container, query) {
    const needle = query.toLowerCase();
    const matches = el => el.textContent.toLowerCase().includes(needle);
    let count = 0;
    for (const line of container.querySelectorAll('li, tr, p, blockquote, pre, h1, h2, h3')) {
        if (line.parentElement?.closest('li, tr, p, blockquote, pre')) continue;
        if (matches(line)) {
            count++;
        } else {
            line.remove();
        }
    }
    for (const list of container.querySelectorAll('ul, ol, table')) {
        if (!list.querySelector('li, tr')) list.remove();
    }
    return count;
}

/**
 * @param {HTMLElement} container
 * @param {string} query
 * @returns {number | void}
 */
function renderSlashCommands(container, query) {
    const browser = new SlashCommandBrowser();
    browser.renderInto(container);
    if (!query) return;
    const input = /** @type {HTMLInputElement} */ (browser.search);
    input.value = query;
    input.dispatchEvent(new Event('input'));
    return browser.dom.querySelectorAll('.autoComplete > :not(.isFiltered)').length;
}

/**
 * @param {HTMLElement} container
 * @param {string} query
 * @returns {number | void}
 */
function renderMacros(container, query) {
    const browser = new MacroBrowser();
    browser.renderInto(container);
    if (!query) return;
    browser.searchInput.value = query;
    browser.searchInput.dispatchEvent(new Event('input'));
    return browser.dom.querySelectorAll('.macro-item:not(.isFiltered)').length;
}

/** @type {{ layer: import('./editor-layer.js').EditorLayer, show: (topicId: string) => void } | null} */
let open = null;

/**
 * Opens the help panel at a topic, or shows that topic in the one already open and brings it forward.
 * @param {string} [name] A topic id or alias; anything unknown opens the overview.
 */
export function openHelp(name) {
    const topic = findHelpTopic(name) ?? findHelpTopic(DEFAULT_HELP_TOPIC);
    if (open) {
        open.show(topic.id);
        raiseDrawer(open.layer.element);
        updateDrawerStack();
        return;
    }
    open = buildPanel(topic.id);
}

/** @returns {boolean} Whether the help panel is open. */
export function isHelpOpen() {
    return open !== null;
}

/**
 * @param {string} firstTopicId
 */
function buildPanel(firstTopicId) {
    const panel = document.createElement('div');
    panel.classList.add('helpPanel');
    panel.innerHTML = `
        <div class="helpHeader">
            <div class="helpMenuButton menu_button fa-solid fa-bars" role="button" tabindex="0"></div>
            <span class="helpHeaderTitle"></span>
        </div>
        <div class="helpMain">
            <nav class="helpNav">
                <input type="search" class="helpSearch text_pole">
                <ul class="helpTopics"></ul>
            </nav>
            <div class="helpContent"></div>
        </div>`;
    const menuButton = /** @type {HTMLElement} */ (panel.querySelector('.helpMenuButton'));
    const headerTitle = /** @type {HTMLElement} */ (panel.querySelector('.helpHeaderTitle'));
    const search = /** @type {HTMLInputElement} */ (panel.querySelector('.helpSearch'));
    const topicList = /** @type {HTMLElement} */ (panel.querySelector('.helpTopics'));
    const content = /** @type {HTMLElement} */ (panel.querySelector('.helpContent'));
    menuButton.title = t`Help topics`;
    search.placeholder = t`Search all help`;
    search.setAttribute('aria-label', t`Search all help`);

    let currentTopicId = firstTopicId;
    // Each draw gets a number; a draw that finishes after a newer one started drops its result.
    let drawNumber = 0;

    const setMenuOpen = (value) => panel.classList.toggle('helpNavOpen', value);
    menuButton.addEventListener('click', () => setMenuOpen(!panel.classList.contains('helpNavOpen')));
    menuButton.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setMenuOpen(!panel.classList.contains('helpNavOpen'));
        }
    });

    /**
     * @param {Map<string, number>} [counts] Matches per topic while searching.
     */
    const drawTopicList = (counts) => {
        topicList.replaceChildren();
        for (const topic of getHelpTopics()) {
            if (counts && !counts.has(topic.id)) continue;
            const item = document.createElement('li');
            item.classList.add('helpTopic');
            item.dataset.topic = topic.id;
            item.tabIndex = 0;
            item.setAttribute('role', 'button');
            item.textContent = topic.title;
            if (counts) {
                const count = document.createElement('span');
                count.classList.add('helpTopicCount');
                count.textContent = String(counts.get(topic.id));
                item.appendChild(count);
            }
            item.classList.toggle('active', !counts && topic.id === currentTopicId);
            topicList.appendChild(item);
        }
    };

    const pick = (topicId) => {
        setMenuOpen(false);
        if (search.value.trim()) {
            content.querySelector(`.helpSection[data-topic="${CSS.escape(topicId)}"]`)?.scrollIntoView({ block: 'start' });
            return;
        }
        show(topicId);
    };
    topicList.addEventListener('click', event => {
        const item = /** @type {HTMLElement} */ (event.target).closest('.helpTopic');
        if (item instanceof HTMLElement) pick(item.dataset.topic);
    });
    topicList.addEventListener('keydown', event => {
        const item = /** @type {HTMLElement} */ (event.target).closest('.helpTopic');
        if (item instanceof HTMLElement && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            pick(item.dataset.topic);
        }
    });

    /** @param {string} topicId */
    const show = async (topicId) => {
        const topic = findHelpTopic(topicId) ?? findHelpTopic(DEFAULT_HELP_TOPIC);
        currentTopicId = topic.id;
        if (search.value) search.value = '';
        const number = ++drawNumber;
        headerTitle.textContent = topic.title;
        drawTopicList();
        const section = document.createElement('div');
        section.classList.add('helpSection');
        section.dataset.topic = topic.id;
        content.replaceChildren(section);
        content.scrollTop = 0;
        try {
            await topic.render(section, '');
        } catch (error) {
            if (number !== drawNumber) return;
            console.error(`Help topic "${topic.id}" failed to draw:`, error);
            section.textContent = t`This help topic could not be shown.`;
        }
    };

    const runSearch = async () => {
        const query = search.value.trim();
        if (!query) {
            show(currentTopicId);
            return;
        }
        const number = ++drawNumber;
        headerTitle.textContent = t`Search results`;
        /** @type {Map<string, number>} */
        const counts = new Map();
        const results = document.createElement('div');
        content.replaceChildren(results);
        content.scrollTop = 0;
        for (const topic of getHelpTopics()) {
            const section = document.createElement('div');
            section.classList.add('helpSection');
            section.dataset.topic = topic.id;
            const heading = document.createElement('h3');
            heading.classList.add('helpSectionTitle');
            heading.textContent = topic.title;
            const body = document.createElement('div');
            section.append(heading, body);
            // Topics draw into the page, so search results can use the topics' own matching (the slash command
            // and macro browsers filter their own items).
            results.appendChild(section);
            let count = 0;
            try {
                count = Number(await topic.render(body, query)) || 0;
            } catch (error) {
                console.error(`Help topic "${topic.id}" failed to search:`, error);
            }
            if (number !== drawNumber) return;
            if (count > 0) {
                counts.set(topic.id, count);
            } else {
                section.remove();
            }
        }
        drawTopicList(counts);
        if (!counts.size) {
            const none = document.createElement('div');
            none.classList.add('helpNoResults');
            none.textContent = t`Nothing in help matches this search.`;
            results.appendChild(none);
        }
    };
    search.addEventListener('input', debounce(runSearch, 250));

    const layer = openEditorLayer(panel, {
        closeTitle: t`Close help`,
        closeIcon: 'fa-xmark',
        onClose: () => {
            if (open?.layer === layer) open = null;
        },
    });
    layer.element.classList.add('helpLayer');
    raiseDrawer(layer.element);
    updateDrawerStack();
    show(firstTopicId);
    return { layer, show };
}
