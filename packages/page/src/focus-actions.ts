import { createCommands } from './commands.ts';
import type { Commands } from './commands.ts';

// The commands about the element that has focus: a field's Confirm and Cancel, a list's Next and Previous, a control's
// Activate. Each is one command; an element gives its own action for it, found from the focused element outward.

export type FocusAction = 'confirm' | 'cancel' | 'next' | 'previous' | 'activate';

/** `false` leaves the key to whatever else handles it */
export type Handler = (event: Event) => boolean | void;

export type Actions = Partial<Record<FocusAction, Handler>> & {
    /** Whether the element's actions apply now; they do by default */
    when?: () => boolean;
};

export type FocusActions = {
    /** Gives an element (and what is inside it) its own actions; the returned function takes them off */
    attach: (element: Element, actions: Actions) => () => void;
    /** An action of the element that has focus, or of the nearest element around it that has one */
    of: (action: FocusAction) => Handler | undefined;
};

export function createFocusActions(commands: Commands, t: (text: string) => string): FocusActions {
    const attached = new WeakMap<Element, Actions>();

    const of = (action: FocusAction): Handler | undefined => {
        let at: Element | null = typeof document === 'undefined' ? null : document.activeElement;
        while (at) {
            const actions = attached.get(at);
            const handler = actions?.[action];
            if (handler && actions.when?.() !== false) return handler;
            at = at.parentElement;
        }
        return undefined;
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
            command('confirm', t('Confirm'), ['Enter'], true),
            command('cancel', t('Cancel'), ['Escape'], true),
            command('next', t('Next item'), ['ArrowDown'], true),
            command('previous', t('Previous item'), ['ArrowUp'], true),
            command('activate', t('Activate'), ['Enter', 'Space'], false),
        ],
        { everywhere: true },
    );

    return {
        attach(element, actions) {
            attached.set(element, actions);
            return () => {
                if (attached.get(element) === actions) attached.delete(element);
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
