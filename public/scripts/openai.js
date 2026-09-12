// Back-compat shim: this file was renamed to chat-completion-settings.js (it was never OpenAI-specific -
// "openai" is just this codebase's legacy internal name for the whole Chat Completion category, covering
// every provider under oai_settings.chat_completion_source, not literally OpenAI's API). Kept here, empty
// of real logic, only so third-party extensions built against the old path keep working. New code must not
// import from this path - see the no-restricted-syntax rule in .eslintrc.cjs.
export * from './chat-completion-settings.js';
