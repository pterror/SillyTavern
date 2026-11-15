import { attachActions } from './new-ui-page.js';

/* All selectors that should act as interactables / keyboard buttons by default */
const interactableSelectors = [
    '.interactable',
    '.custom_interactable',
    '.menu_button',
    '.right_menu_button',
    '.drawer-icon',
    '.inline-drawer-icon',
    '.paginationjs-pages li a',
    '.group_select, .character_select, .bogus_folder_select',
    '.avatar-container',
    '.tag .tag_remove',
    '.bg_example',
    '.bg_example .jg-button, .bg_example .mobile-only-menu-toggle',
    '#options a',
    '.mes_buttons .mes_button',
    '.extraMesButtons>div:not(.mes_button)',
    '.swipe_left, .swipe_right',
    '.stscript_btn',
    '.select2_choice_clickable+span.select2-container .select2-selection__choice__display',
    '.avatar_load_preview',
    '.select_chat_block',
    '.select_chat_block .exportRawChatButton',
    '.select_chat_block .exportChatButton',
    '.select_chat_block .PastChat_cross',
    '.select_chat_block .renameChatButton',
];

export const INTERACTABLE_CONTROL_CLASS = 'interactable';
const CUSTOM_INTERACTABLE_CONTROL_CLASS = 'custom_interactable';

const NOT_FOCUSABLE_CONTROL_CLASS = 'not_focusable';
const DISABLED_CONTROL_CLASS = 'disabled';

/** @type {MutationObserver} */
// eslint-disable-next-line no-restricted-syntax -- watches the page from before the ban: whatever changes it is to say so
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

function isKeyboardInteractable(control) {
    return interactableSelectors.some(selector => control.matches(selector));
}

function makeKeyboardInteractable(...interactables) {
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

/** Controls the browser activates by Enter or Space itself */
const NATIVELY_ACTIVATED = 'button, a[href], input, select, summary, textarea';

/**
 * The interactable that has focus or holds it, unless the browser activates it itself or it is disabled
 * @returns {HTMLElement | null}
 */
function focusedInteractable() {
    const focused = document.activeElement;
    if (!(focused instanceof HTMLElement) || focused.matches(NATIVELY_ACTIVATED)) return null;
    let target = focused;
    while (target && !isKeyboardInteractable(target)) {
        target = target.parentElement;
    }
    if (!target || target.matches(NATIVELY_ACTIVATED) || target.classList.contains(DISABLED_CONTROL_CLASS)) return null;
    return target;
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

    // On the root, so an element nearer the focus that has its own Activate comes first
    attachActions(document.documentElement, {
        when: () => focusedInteractable() !== null,
        activate: () => focusedInteractable()?.click(),
    });
}
