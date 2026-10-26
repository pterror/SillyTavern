import type { Plugin } from 'vite-plus/lint/plugins';
import declaredImports from './rules/declared-imports.ts';
import noHtmlStrings from './rules/no-html-strings.ts';
import noModuleState from './rules/no-module-state.ts';
import propsReadInPlace from './rules/props-read-in-place.ts';

const plugin: Plugin = {
    meta: { name: 'st' },
    rules: {
        'declared-imports': declaredImports,
        'no-html-strings': noHtmlStrings,
        'no-module-state': noModuleState,
        'props-read-in-place': propsReadInPlace,
    },
};

export default plugin;
