import { saveSettingsDebounced } from '../script.js';
import { getSortableDelay, uuidv4 } from './utils.js';


/**
 * Displays the logit bias list in the specified container.
 * @param {object} logitBias Logit bias object
 * @param {string} containerSelector Container element selector
 * @param {string} [settingsKey] Top-level settings key this logit bias array actually lives under
 * (oai_settings/nai_settings/textgenerationwebui_settings) - saveSettingsDebounced() only flushes the
 * keys it's told are dirty, so passing the wrong one here silently drops the edit on the next save.
 * @returns
 */
export function displayLogitBias(logitBias, containerSelector, settingsKey = 'oai_settings') {
    if (!Array.isArray(logitBias)) {
        console.log('Logit bias set not found');
        return;
    }

    const list = $(containerSelector).find('.logit_bias_list');
    list.empty();

    for (const entry of logitBias) {
        if (entry) {
            createLogitBiasListItem(entry, logitBias, containerSelector, settingsKey);
        }
    }

    // Check if a sortable instance exists
    if (list.sortable('instance') !== undefined) {
        // Destroy the instance
        list.sortable('destroy');
    }

    // Make the list sortable
    list.sortable({
        delay: getSortableDelay(),
        handle: '.drag-handle',
        stop: function () {
            const order = [];
            list.children().each(function () {
                order.unshift($(this).data('id'));
            });
            logitBias.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
            console.log('Logit bias reordered:', logitBias);
            saveSettingsDebounced(settingsKey);
        },
    });
}

/**
 * Creates a new logit bias entry
 * @param {object[]} logitBias Array of logit bias objects
 * @param {string} containerSelector Container element ID
 * @param {string} [settingsKey] Top-level settings key this logit bias array lives under - see displayLogitBias().
 */
export function createNewLogitBiasEntry(logitBias, containerSelector, settingsKey = 'oai_settings') {
    const entry = { id: uuidv4(), text: '', value: 0 };
    logitBias.push(entry);
    createLogitBiasListItem(entry, logitBias, containerSelector, settingsKey);
    saveSettingsDebounced(settingsKey);
}

/**
 * Creates a logit bias list item.
 * @param {object} entry Logit bias entry
 * @param {object[]} logitBias Array of logit bias objects
 * @param {string} containerSelector Container element ID
 * @param {string} [settingsKey] Top-level settings key this logit bias array lives under - see displayLogitBias().
 */
function createLogitBiasListItem(entry, logitBias, containerSelector, settingsKey = 'oai_settings') {
    const id = entry.id;
    const template = $('#logit_bias_template .logit_bias_form').clone();
    template.data('id', id);
    template.find('.logit_bias_text').val(entry.text).on('input', function () {
        entry.text = $(this).val();
        saveSettingsDebounced(settingsKey);
    });
    template.find('.logit_bias_value').val(entry.value).on('input', function () {
        entry.value = Number($(this).val());
        saveSettingsDebounced(settingsKey);
    });
    template.find('.logit_bias_remove').on('click', function () {
        $(this).closest('.logit_bias_form').remove();
        const index = logitBias.indexOf(entry);
        if (index > -1) {
            logitBias.splice(index, 1);
        }
        saveSettingsDebounced(settingsKey);
    });
    $(containerSelector).find('.logit_bias_list').prepend(template);
}

