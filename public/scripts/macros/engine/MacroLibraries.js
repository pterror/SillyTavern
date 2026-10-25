/**
 * The libraries the macros use, given by whoever runs the engine (macro-engine-init.js): the page and the server each
 * load them their own way.
 */

/** @type {typeof import('moment')} */
export let moment;
/** @type {any} */
export let seedrandom;
/** @type {any} */
export let droll;
/** @type {(timestamp: string|number) => import('moment').Moment} A message's send date as a moment. */
export let timestampToMoment;

/**
 * @param {{ moment: typeof import('moment'), seedrandom: any, droll: any, timestampToMoment: (timestamp: string|number) => import('moment').Moment }} libraries
 */
export function setMacroLibraries(libraries) {
    ({ moment, seedrandom, droll, timestampToMoment } = libraries);
}
