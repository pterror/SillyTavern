/**
 * The libraries the live editor uses, bundled by Webpack into /live-editor-lib.js. It is a separate file from
 * /lib.js so the editor's code loads only when a field is first edited. Every CodeMirror package must come through
 * here, so they share the one copy of @codemirror/state they need.
 */
export * as state from '@codemirror/state';
export * as view from '@codemirror/view';
export * as language from '@codemirror/language';
export * as commands from '@codemirror/commands';
export * as search from '@codemirror/search';
export * as autocomplete from '@codemirror/autocomplete';
export * as langMarkdown from '@codemirror/lang-markdown';
export * as lezerMarkdown from '@lezer/markdown';
export * as lezerHighlight from '@lezer/highlight';
export * as lezerCommon from '@lezer/common';
