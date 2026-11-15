import { createCommands } from './commands.ts';
import type { Commands } from './commands.ts';

// The commands about the element that has focus: a field's Confirm and Cancel, a list's Next and Previous, a control's
// Activate. Each is one command; an element gives its own action for it, found from the focused element outward.

export type FocusAction = 'confirm' | 'cancel' | 'next' | 'previous' | 'activate';

/** `false` passes the key on: to the next element out that has the action, then to whatever else handles it */
export type Handler = (event: Event) => boolean | void;

export type Actions = Partial<Record<FocusAction, Handler>> & {
    /** Whether the element's actions apply now; they do by default */
    when?: () => boolean;
};

export type FocusActions = {
    /**
     * Gives an element (and what is inside it) its own actions, tried after the ones it was given before; the returned
     * function takes these off
     */
    attach: (element: Element, actions: Actions) => () => void;
    /** The action of the element that has focus and of each element around it that has one, nearest first */
    of: (action: FocusAction) => Handler | undefined;
};

export function createFocusActions(commands: Commands, t: (text: string) => string): FocusActions {
    const attached = new WeakMap<Element, Actions[]>();

    const of = (action: FocusAction): Handler | undefined => {
        const handlers: Handler[] = [];
        let at: Element | null = typeof document === 'undefined' ? null : document.activeElement;
        while (at) {
            for (const actions of attached.get(at) ?? []) {
                const handler = actions[action];
                if (handler && actions.when?.() !== false) handlers.push(handler);
            }
            at = at.parentElement;
        }
        if (handlers.length === 0) return undefined;
        return (event) => (handlers.some((handler) => handler(event) !== false) ? undefined : false);
    };

    const command = (action: FocusAction, label: string, keys: readonly string[], typing: boolean) => ({
        id: `focus.${action}`,
        label,
        category: t('Fields and lists'),
        keys,
        typing,
        when: () => of(action) !== undefined,
        run: (event: Event) => of(action)?.(event),
    });

    commands.register(
        [
            command('confirm', t('Confirm'), ['Enter', 'ctrl+Enter'], true),
            command('cancel', t('Cancel'), ['Escape'], true),
            command('next', t('Next item'), ['ArrowDown'], true),
            command('previous', t('Previous item'), ['ArrowUp'], true),
            command('activate', t('Activate'), ['Enter', 'Space'], false),
        ],
        { everywhere: true },
    );

    return {
        attach(element, actions) {
            const own = { ...actions };
            attached.set(element, [...(attached.get(element) ?? []), own]);
            return () => {
                const left = (attached.get(element) ?? []).filter((each) => each !== own);
                if (left.length > 0) attached.set(element, left);
                else attached.delete(element);
            };
        },
        of,
    };
}

/** A registry and its focus actions, for a surface mounted on its own (a test) */
export function testCommands(): { commands: Commands; focusActions: FocusActions } {
    const commands = createCommands();
    return { commands, focusActions: createFocusActions(commands, (text) => text) };
}
