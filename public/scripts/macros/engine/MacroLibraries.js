/** @type {typeof import('moment')} */
export let moment;
/** @type {any} */
export let seedrandom;
/** @type {any} */
export let droll;
/** @type {(timestamp: string|number) => import('moment').Moment} */
export let timestampToMoment;

/**
 * @param {{ moment: typeof import('moment'), seedrandom: any, droll: any, timestampToMoment: (timestamp: string|number) => import('moment').Moment }} libraries
 */
export function setMacroLibraries(libraries) {
    ({ moment, seedrandom, droll, timestampToMoment } = libraries);
}
