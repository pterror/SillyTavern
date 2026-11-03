import { EventEmitter } from '../lib/eventemitter.js';

export const event_types = {
    APP_READY: 'app_ready',
    MESSAGE_SWIPED: 'message_swiped',
    MESSAGE_RECEIVED: 'message_received',
    MESSAGE_EDITED: 'message_edited',
    MESSAGE_DELETED: 'message_deleted',
    MESSAGE_UPDATED: 'message_updated',
    IMPERSONATE_READY: 'impersonate_ready',
    CHAT_CHANGED: 'chat_id_changed',
    // TODO: Naming convention is inconsistent with other events
    CHAT_LOADED: 'chatLoaded',
    GENERATION_STARTED: 'generation_started',
    GENERATION_STOPPED: 'generation_stopped',
    GENERATION_ENDED: 'generation_ended',
    SETTINGS_LOADED: 'settings_loaded',
    SETTINGS_UPDATED: 'settings_updated',
    SETTINGS_LOADED_BEFORE: 'settings_loaded_before',
    CHATCOMPLETION_SOURCE_CHANGED: 'chatcompletion_source_changed',
    CHATCOMPLETION_MODEL_CHANGED: 'chatcompletion_model_changed',
    OAI_PRESET_CHANGED_BEFORE: 'oai_preset_changed_before',
    OAI_PRESET_CHANGED_AFTER: 'oai_preset_changed_after',
    WORLDINFO_SETTINGS_UPDATED: 'worldinfo_settings_updated',
    CHARACTER_EDITOR_OPENED: 'character_editor_opened',
    CHARACTER_EDITED: 'character_edited',
    CHARACTER_PAGE_LOADED: 'character_page_loaded',
    CHARACTER_GROUP_OVERLAY_STATE_CHANGE_AFTER: 'character_group_overlay_state_change_after',
    CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
    CHAT_DELETED: 'chat_deleted',
    CHAT_RENAMED: 'chat_renamed',
    GROUP_CHAT_DELETED: 'group_chat_deleted',
    GENERATE_AFTER_COMBINE_PROMPTS: 'generate_after_combine_prompts',
    GENERATE_AFTER_DATA: 'generate_after_data',
    CHAT_COMPLETION_SETTINGS_READY: 'chat_completion_settings_ready',
    CHAT_COMPLETION_PROMPT_READY: 'chat_completion_prompt_ready',
    // TODO: Naming convention is inconsistent with other events
    CHARACTER_DELETED: 'characterDeleted',
    ONLINE_STATUS_CHANGED: 'online_status_changed',
    CHARACTER_MANAGEMENT_DROPDOWN: 'charManagementDropdown',
};

export const eventSource = new EventEmitter([event_types.APP_READY]);
