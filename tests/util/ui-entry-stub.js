export function start() {
    throw new Error('The new page is not available in unit tests');
}

export const SERVER_OWNED = new Set();

export * from '../../packages/occlusion/src/index.ts';
