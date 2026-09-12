/* All selectors that should act as interactables / keyboard buttons by default */
const interactableSelectors = [
    '.interactable', // Can also be added manually in code
    '.custom_interactable', // See makeKeyboardInteractable()
    '.menu_button',
    '.right_menu_button',
    '.drawer-icon',
    '.inline-drawer-icon',
    '.paginationjs-pages li a',
    '.group_select, .character_select, .bogus_folder_select',
    '.swipe_picker_block',
    '.avatar-container',
    '.tag .tag_remove',
    '.bg_example',
    '.bg_example .jg-button, .bg_example .mobile-only-menu-toggle',
    '#options a',
    '.mes_buttons .mes_button',
    '.extraMesButtons>div:not(.mes_button)',
    '.swipe_left, .swipe_right',
    '.stscript_btn',
    '.select2_choice_clickable+span.select2-container .select2-selection__choice__display', // Only the clickable variant
    '.avatar_load_preview',
    '.bg_tabs_list .bg_tab_button',
    '.select_chat_block',
    '.select_chat_block .exportRawChatButton',
    '.select_chat_block .exportChatButton',
    '.select_chat_block .PastChat_cross',
    '.select_chat_block .renameChatButton',
];

if (CSS.supports('selector(:has(*))')) {
    interactableSelectors.push('#extensionsMenu div:has(.extensionsMenuExtensionButton)');
}

export const INTERACTABLE_CONTROL_CLASS = 'interactable';
export const CUSTOM_INTERACTABLE_CONTROL_CLASS = 'custom_interactable';

export const NOT_FOCUSABLE_CONTROL_CLASS = 'not_focusable';
export const DISABLED_CONTROL_CLASS = 'disabled';

/** @type {MutationObserver} */
const observer = new MutationObserver(mutations => {
    mutations.forEach(mutation => {
        if (mutation.type === 'childList') {
            mutation.addedNodes.forEach(handleNodeChange);
        }
        if (mutation.type === 'attributes') {
            const target = mutation.target;
            if (mutation.attributeName === 'class' && target instanceof Element) {
                handleNodeChange(target);
            }
        }
    });
});

function handleNodeChange(node) {
    if (node.nodeType === Node.ELEMENT_NODE && node instanceof Element) {
        if (isKeyboardInteractable(node)) {
            makeKeyboardInteractable(node);
        }
        initializeInteractables(node);

        if (node.classList.contains('scroll-reset-container')) {
            applyScrollResetBehavior(node);
        }
        initializeScrollResetBehaviors(node);
    }
}

/**
 * @param {string} interactableSelector - Supports class combinations chained via dots (e.g. `tag.actionable`) and sub selectors.
 */
export function registerInteractableType(interactableSelector, { disabledByDefault = false, notFocusableByDefault = false } = {}) {
    interactableSelectors.push(interactableSelector);

    const interactables = document.querySelectorAll(interactableSelector);

    if (disabledByDefault || notFocusableByDefault) {
        interactables.forEach(interactable => {
            if (disabledByDefault) interactable.classList.add(DISABLED_CONTROL_CLASS);
            if (notFocusableByDefault) interactable.classList.add(NOT_FOCUSABLE_CONTROL_CLASS);
        });
    }

    makeKeyboardInteractable(...interactables);
}

export function isKeyboardInteractable(control) {
    return interactableSelectors.some(selector => control.matches(selector));
}

export function makeKeyboardInteractable(...interactables) {
    interactables.forEach(interactable => {
        if (!isKeyboardInteractable(interactable)) {
            interactable.classList.add(CUSTOM_INTERACTABLE_CONTROL_CLASS);
        }

        if (!interactable.classList.contains(INTERACTABLE_CONTROL_CLASS)) {
            interactable.classList.add(INTERACTABLE_CONTROL_CLASS);
        }

        const hasDisabledOrNotFocusableAncestor = (el) => {
            while (el) {
                if (el.classList.contains(NOT_FOCUSABLE_CONTROL_CLASS) || el.classList.contains(DISABLED_CONTROL_CLASS)) {
                    return true;
                }
                el = el.parentElement;
            }
            return false;
        };

        if (!hasDisabledOrNotFocusableAncestor(interactable)) {
            if (!interactable.hasAttribute('tabindex')) {
                const tabIndex = interactable.getAttribute('data-original-tabindex') ?? '0';
                interactable.setAttribute('tabindex', tabIndex);
            }
        } else {
            interactable.setAttribute('data-original-tabindex', interactable.getAttribute('tabindex'));
            interactable.removeAttribute('tabindex');
        }
    });
}

function initializeInteractables(element = document) {
    const interactables = getAllInteractables(element);
    makeKeyboardInteractable(...interactables);
}

function getAllInteractables(element) {
    return [].concat(...interactableSelectors.map(selector => Array.from(element.querySelectorAll(`${selector}`))));
}

const applyScrollResetBehavior = (container) => {
    container.addEventListener('focusout', (e) => {
        setTimeout(() => {
            const focusedElement = document.activeElement;
            if (!container.contains(focusedElement)) {
                container.scrollTop = 0;
                container.scrollLeft = 0;
            }
        }, 0);
    });
};

function initializeScrollResetBehaviors(element = document) {
    const scrollResetContainers = element.querySelectorAll('.scroll-reset-container');
    scrollResetContainers.forEach(container => applyScrollResetBehavior(container));
}

function handleGlobalKeyDown(event) {
    if (event.key === 'Enter') {
        if (!(event.target instanceof HTMLElement))
            return;

        if (event.altKey || event.ctrlKey || event.shiftKey)
            return;

        let target = event.target;
        while (target && !isKeyboardInteractable(target)) {
            target = target.parentElement;
        }

        if (target && !target.classList.contains(DISABLED_CONTROL_CLASS)) {
            target.click();
        }
    }
}

export function initKeyboard() {
    observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class'],
    });

    initializeInteractables();
    initializeScrollResetBehaviors();

    document.addEventListener('keydown', handleGlobalKeyDown);
}
