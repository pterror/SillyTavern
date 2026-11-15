import { bindingLookup } from '@pterror/interact-keybinds/binding-lookup';
import { bindingParts } from '@pterror/interact-keybinds/binding-parts';
import { bindingStore } from '@pterror/interact-keybinds/binding-store';
import { bound } from '@pterror/interact-keybinds/bound';
import { findConflict } from '@pterror/interact-keybinds/find-conflict';
import { keyParse } from '@pterror/interact-keybinds/key-parse';
import { keybinds } from '@pterror/interact-keybinds/keybinds';
import { mouseParse } from '@pterror/interact-keybinds/mouse-parse';

// Every action a person can take by a key, a click with a modifier, the palette or the right-click menu: one
// registry, bound with keybinds, laid over by the person's own bindings.

export type Command = {
    id: string;
    label: string;
    /** The heading it is listed under in the help's list, the cheatsheet and the key settings */
    category: string;
    keys?: readonly string[];
    mouse?: readonly string[];
    /** `false` leaves the event to whatever else handles it */
    run: (event: Event) => boolean | void;
    /** Whether it applies now; it is offered and runs only then */
    when?: () => boolean;
    /** Whether its keys also run while text is typed into a field */
    typing?: boolean;
    /**
     * Bound, but left out of the palette, the cheatsheet, the help's list and the key settings: a guard or another
     * way to reach something listed (Escape where focus isn't), not an action of its own
     */
    hidden?: boolean;
};

export type Placement = {
    /** Where its keys are listened to; the window by default */
    target?: EventTarget;
    capture?: boolean;
    /**
     * Its keys also run with focus inside an open popover or dialog, where keybinds' overlay rule blocks what listens
     * outside it: they are bound on each overlay while it is open, as well as on the window. For commands about the
     * focused element itself (confirm or cancel a field).
     */
    everywhere?: boolean;
};

export type Overrides = Readonly<
    Record<string, Readonly<{ keys?: readonly string[]; mouse?: readonly string[]; pad?: readonly string[] }>>
>;

export type BindingStorage = {
    load: () => Overrides;
    save: (overrides: Overrides) => void;
    subscribe?: (listener: (overrides: Overrides) => void) => () => void;
};

export type Conflict = { binding: string; ids: readonly string[] };

type Registration = { commands: readonly Command[]; placement: Placement };

const keyLookup = bindingLookup((step) => keyParse(step));
const mouseLookup = bindingLookup((step) => mouseParse(step));

/** A binding that doesn't parse (an old or mistyped one a person kept) is left out rather than stopping every other */
function parses(lookup: (binding: string) => string) {
    return (binding: string) => {
        try {
            lookup(binding);
            return true;
        } catch {
            return false;
        }
    };
}

function parsable(command: Command): Command {
    return {
        ...command,
        ...(command.keys ? { keys: command.keys.filter(parses(keyLookup)) } : {}),
        ...(command.mouse ? { mouse: command.mouse.filter(parses(mouseLookup)) } : {}),
    };
}

/**
 * Whether a modal dialog is open and `target` is outside it. The page outside a modal is inert, so what is bound there
 * doesn't run, wherever focus has fallen (keybinds' overlay rule asks only where the key event happened).
 */
function outsideModal(target: EventTarget): boolean {
    if (typeof document === 'undefined') return false;
    const modals = [...document.querySelectorAll('dialog:modal')];
    return modals.length > 0 && !modals.some((modal) => target instanceof Node && modal.contains(target));
}

/** A key something else already took (CodeMirror accepting a suggestion), or one an input method is composing */
function taken(event: Event): boolean {
    return event.defaultPrevented || (event instanceof KeyboardEvent && event.isComposing);
}

/** A command's bindings as people see them: one list of parts (`Ctrl`, `K`) per binding */
export function shownBindings(command: Pick<Command, 'keys' | 'mouse'>): readonly (readonly string[])[] {
    return bindingParts({
        ...(command.keys ? { keys: command.keys.filter(parses(keyLookup)) } : {}),
        ...(command.mouse ? { mouse: command.mouse.filter(parses(mouseLookup)) } : {}),
    });
}

export type Commands = ReturnType<typeof createCommands>;

/** The page's one registry of commands */
export function createCommands() {
    const registrations: Registration[] = [];
    const listeners = new Set<() => void>();
    let store = bindingStore({ load: () => ({}), save: () => undefined });
    let stopStore: () => void = () => undefined;
    const overlays = new Set<Element>();
    let stops: (() => void)[] = [];
    let watchingOverlays = false;
    let pauses = 0;

    function tell() {
        for (const listener of listeners) listener();
    }

    /** Each command with the person's bindings laid over its own */
    function withOverrides(list: readonly Command[]): Command[] {
        const overrides = store.get();
        return list.map((command) => {
            const override = Object.hasOwn(overrides, command.id) ? overrides[command.id] : undefined;
            if (!override) return command;
            return {
                ...command,
                ...(override.keys ? { keys: override.keys } : {}),
                ...(override.mouse ? { mouse: override.mouse } : {}),
            };
        });
    }

    function bindAt(list: readonly Command[], target: EventTarget, capture: boolean) {
        const bindable = withOverrides(list)
            .map(parsable)
            .filter((command) => (command.keys?.length ?? 0) > 0 || (command.mouse?.length ?? 0) > 0);
        if (bindable.length === 0) return;
        stops.push(
            keybinds(
                bindable.map((command) => ({
                    ...(command.keys ? { keys: command.keys } : {}),
                    ...(command.mouse ? { mouse: command.mouse } : {}),
                    run: (event: Event) => (taken(event) ? false : command.run(event)),
                    when: () => pauses === 0 && !outsideModal(target) && command.when?.() !== false,
                    ...(command.typing === true ? { typing: true } : {}),
                })),
                { target, capture },
            ),
        );
    }

    /** Binds every registration again: one keybinds() per place, its commands in the order they were registered */
    function rebind() {
        for (const stop of stops) stop();
        stops = [];
        const places = new Map<EventTarget, Map<boolean, Command[]>>();
        const add = (target: EventTarget, capture: boolean, list: readonly Command[]) => {
            const byPhase = places.get(target) ?? new Map<boolean, Command[]>();
            places.set(target, byPhase);
            byPhase.set(capture, [...(byPhase.get(capture) ?? []), ...list]);
        };
        for (const { commands, placement } of registrations) {
            const capture = placement.capture === true;
            add(placement.target ?? globalThis, capture, commands);
            if (placement.everywhere === true) {
                for (const overlay of overlays) add(overlay, capture, commands);
            }
        }
        for (const [target, byPhase] of places) {
            for (const [capture, list] of byPhase) bindAt(list, target, capture);
        }
    }

    function watchOverlays() {
        if (watchingOverlays || typeof document === 'undefined') return;
        watchingOverlays = true;
        const changed = (event: Event) => {
            const element = event.target;
            if (!(element instanceof Element)) return;
            const state = 'newState' in event ? event.newState : undefined;
            const opening = event.type === 'beforetoggle' && state === 'open';
            const closed = event.type === 'close' || (event.type === 'toggle' && state === 'closed');
            if (opening === closed) return;
            if (opening === overlays.has(element)) return;
            if (opening) overlays.add(element);
            else overlays.delete(element);
            for (const each of [...overlays]) if (!each.isConnected) overlays.delete(each);
            rebind();
        };
        for (const type of ['beforetoggle', 'toggle', 'close']) document.addEventListener(type, changed, true);
    }

    /** Adds commands, bound at once; the returned function takes them out again */
    function registerCommands(list: readonly Command[], placement: Placement = {}): () => void {
        const registration: Registration = { commands: list, placement };
        registrations.push(registration);
        if (placement.everywhere === true) watchOverlays();
        rebind();
        tell();
        return () => {
            const at = registrations.indexOf(registration);
            if (at === -1) return;
            registrations.splice(at, 1);
            rebind();
            tell();
        };
    }

    /** Every command, once per id (the first registered), with the person's bindings, in the order registered */
    function allCommands(): readonly Command[] {
        const seen = new Set<string>();
        const all: Command[] = [];
        for (const { commands } of registrations) {
            for (const command of commands) {
                if (seen.has(command.id)) continue;
                seen.add(command.id);
                all.push(command);
            }
        }
        return withOverrides(all);
    }

    /** The registration of each id that applies now: its `when` holds, and focus is where its keys are listened to */
    function availableCommands(): readonly Command[] {
        const focused = typeof document === 'undefined' ? null : document.activeElement;
        const seen = new Set<string>();
        const found: Command[] = [];
        for (const { commands, placement } of registrations) {
            const target = placement.target;
            const here =
                target === undefined ||
                target === globalThis ||
                (target instanceof Node && !!focused && target.contains(focused));
            if (!here) continue;
            for (const command of commands) {
                if (seen.has(command.id) || command.when?.() === false) continue;
                seen.add(command.id);
                found.push(command);
            }
        }
        return withOverrides(found);
    }

    function watchCommands(listener: () => void): () => void {
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
        };
    }

    /** Where the person's bindings are kept; until set, they are kept nowhere */
    function keepBindingsIn(storage: BindingStorage) {
        stopStore();
        store = bindingStore(storage);
        stopStore = store.watch(() => {
            rebind();
            tell();
        });
        rebind();
        tell();
    }

    /** The person's bindings: read, heard and set, as keybinds' settings and rebind take them */
    const bindingOverrides = {
        get: () => store.get(),
        set: (overrides: Overrides) => {
            store.set(overrides);
        },
        watch: (listener: () => void) => store.watch(listener),
    };

    type Entry = { label: string; category: string; keys?: readonly string[]; mouse?: readonly string[] };

    /** Each command's label, category and default bindings, once per id (the first registered) */
    function entries(withHidden: boolean): Record<string, Entry> {
        const seen = new Set<string>();
        const schema: Record<string, Entry> = {};
        for (const { commands } of registrations) {
            for (const command of commands) {
                if (seen.has(command.id)) continue;
                seen.add(command.id);
                if (command.hidden === true && !withHidden) continue;
                schema[command.id] = {
                    label: command.label,
                    category: command.category,
                    ...(command.keys ? { keys: command.keys } : {}),
                    ...(command.mouse ? { mouse: command.mouse } : {}),
                };
            }
        }
        return schema;
    }

    /** The schema keybinds' settings and cheatsheet take: each command not hidden */
    function commandSchema(): Record<string, Entry> {
        return entries(false);
    }

    /**
     * Every binding more than one command has, by keybinds' conflict check over the bindings in effect. Commands that
     * share a key and never apply at once (Escape for a field and for a drawer) are listed too: which runs is the order
     * they were registered in and their `when`. Hidden commands are bound, so they are counted.
     */
    function bindingConflicts(): readonly Conflict[] {
        const bindings = bound(entries(true), store.get());
        const found = new Map<string, Set<string>>();
        for (const [id, entry] of Object.entries(bindings)) {
            for (const [field, lookup] of [
                ['keys', keyLookup],
                ['mouse', mouseLookup],
            ] as const) {
                for (const binding of entry[field] ?? []) {
                    const other = findConflict(bindings, { binding, except: id, field, lookup });
                    if (other === undefined) continue;
                    const key = `${field}:${lookup(binding)}`;
                    const ids = found.get(key) ?? new Set<string>();
                    ids.add(id).add(other);
                    found.set(key, ids);
                }
            }
        }
        return [...found].map(([binding, ids]) => ({ binding, ids: [...ids] }));
    }

    /** Until the returned function is called, no command runs from its bindings: a binding is being recorded */
    function pause(): () => void {
        pauses += 1;
        let resumed = false;
        return () => {
            if (resumed) return;
            resumed = true;
            pauses -= 1;
        };
    }

    /** A command's first binding as people see it on this platform (`Ctrl+Space`), or none if it has none */
    function shownKeys(id: string): string | undefined {
        const command = allCommands().find((each) => each.id === id);
        return command === undefined ? undefined : shownBindings(command)[0]?.join('+');
    }

    return {
        register: registerCommands,
        pause,
        all: allCommands,
        shownKeys,
        available: availableCommands,
        watch: watchCommands,
        keepBindingsIn,
        overrides: bindingOverrides,
        schema: commandSchema,
        conflicts: bindingConflicts,
    };
}
