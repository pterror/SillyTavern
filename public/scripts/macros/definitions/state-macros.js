import { MacroRegistry, MacroCategory } from '../engine/MacroRegistry.js';
import { findExtensionIn } from '../../util/string-args.js';

export function registerStateMacros() {
    MacroRegistry.registerMacro('lastGenerationType', {
        category: MacroCategory.STATE,
        description: 'Type of the last queued generation request (e.g. "normal", "impersonate", "regenerate", "quiet", "swipe", "continue"). Empty if none yet or chat was switched.',
        returns: 'Type of the last queued generation request.',
        handler: ({ env }) => env.state.lastGenerationType ?? '',
    });

    MacroRegistry.registerMacro('hasExtension', {
        category: MacroCategory.STATE,
        unnamedArgs: [{
            name: 'extensionName',
            type: 'string',
            description: 'The name of the extension to check',
        }],
        description: 'Checks if a specific extension is enabled. If the extension does not exist, returns false.',
        returns: 'true if the extension is enabled, false otherwise.',
        handler: ({ unnamedArgs: [extensionName], env }) => String((env.state.extensions && findExtensionIn(env.state.extensions, extensionName)?.enabled) ?? false),
    });
}
