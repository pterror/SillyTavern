import { SlashCommandParser } from '../SlashCommandParser.js';
import { SlashCommand } from '../SlashCommand.js';
import { Fuse } from '../../../lib.js';
import { isMobile } from '../../RossAscends-mods.js';
import { background_settings } from '../../backgrounds.js';
import { t } from '../../i18n.js';
import { playMessageSound } from '../../power-user.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from '../SlashCommandArgument.js';
import { commonEnumProviders } from '../SlashCommandCommonEnumsProvider.js';
import { showFontAwesomePicker } from '../../utils.js';

function setBackgroundCallback(_, bg) {
    if (!bg) {
        // Report the background name when called without args
        return background_settings.name;
    }

    console.log('Set background to ' + bg);

    const bgElements = Array.from(document.querySelectorAll('.bg_example')).map((x) => ({ element: x, bgfile: x.getAttribute('bgfile') }));

    const fuse = new Fuse(bgElements, { keys: ['bgfile'] });
    const result = fuse.search(bg);

    if (!result.length) {
        toastr.error(t`No background found with name "${bg}"`);
        return '';
    }

    const bgElement = result[0].item.element;

    if (bgElement instanceof HTMLElement) {
        bgElement.click();
    }

    return '';
}

export function registerUiCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'panels',
        callback: function () {
            $('#option_settings').trigger('click');
            return '';
        },
        aliases: ['togglepanels'],
        helpString: t`Toggle UI panels on/off`,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'bg',
        callback: setBackgroundCallback,
        aliases: ['background'],
        returns: t`the current background`,
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`background filename`,
                typeList: [ARGUMENT_TYPE.STRING],
                enumProvider: commonEnumProviders.backgrounds,
            }),
        ],
        helpString: `
        <div>
            ${t`Sets a background according to the provided filename. Partial names allowed.`}
        </div>
        <div>
            ${t`If no background is provided, this will return the currently selected background.`}
        </div>
        <div>
            <strong>${t`Example:`}</strong>
            <ul>
                <li>
                    <pre><code>/bg beach.jpg</code></pre>
                </li>
                <li>
                    <pre><code>/bg</code></pre>
                </li>
            </ul>
        </div>
    `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'pick-icon',
        callback: async () => ((await showFontAwesomePicker()) ?? false).toString(),
        returns: t`The chosen icon name or false if cancelled.`,
        helpString: `
                <div>${t`Opens a popup with all the available Font Awesome icons and returns the selected icon's name.`}</div>
                <div>
                    <strong>${t`Example:`}</strong>
                    <ul>
                        <li>
                            <pre><code>/pick-icon |\n/if left={{pipe}} rule=eq right=false\n\telse={: /echo chosen icon: "{{pipe}}" :}\n\t{: /echo cancelled icon selection :}\n|</code></pre>
                        </li>
                    </ul>
                </div>
            `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'is-mobile',
        callback: () => String(isMobile()),
        returns: ARGUMENT_TYPE.BOOLEAN,
        helpString: t`Returns true if the current device is a mobile device, false otherwise. Equivalent to <code>{{isMobile}}</code> macro.`,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'beep',
        aliases: ['ding'],
        returns: t`an empty string`,
        callback: async () => {
            playMessageSound({ force: true });
            return '';
        },
        helpString: t`Plays the message received sound effect.`,
    }));
}
