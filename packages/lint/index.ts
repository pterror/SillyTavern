import type { Plugin } from 'vite-plus/lint/plugins';
import declaredImports from './rules/declared-imports.ts';
import noHtmlStrings from './rules/no-html-strings.ts';
import noModuleState from './rules/no-module-state.ts';
import reactiveInArrow from './rules/reactive-in-arrow.ts';

const plugin: Plugin = {
    meta: { name: 'st' },
    rules: {
        'declared-imports': declaredImports,
        'no-html-strings': noHtmlStrings,
        'no-module-state': noModuleState,
        'reactive-in-arrow': reactiveInArrow,
    },
};

export default plugin;
