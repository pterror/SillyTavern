import { MacroRegistry, MacroCategory } from '../engine/MacroRegistry.js';

export function registerStateMacros() {
    MacroRegistry.registerMacro('lastGenerationType', {
        category: MacroCategory.STATE,
        description: 'Type of the last queued generation request (e.g. "normal", "impersonate", "regenerate", "quiet", "swipe", "continue"). Empty if none yet or chat was switched.',
        returns: 'Type of the last queued generation request.',
        handler: ({ env }) => env.state.lastGenerationType ?? '',
    });
}
