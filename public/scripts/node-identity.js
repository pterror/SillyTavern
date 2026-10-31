import { getStringHash } from './utils.js';

const PROVISIONAL_NODE_PREFIX = 'card:';

/**
 * @param {string|undefined} speaker
 * @param {string|undefined} mes
 * @returns {string}
 */
export function provisionalNodeId(speaker, mes) {
    return PROVISIONAL_NODE_PREFIX + getStringHash(`c${speaker ?? ''} ${mes ?? ''}`);
}

/**
 * @param {unknown} nodeId
 * @returns {nodeId is string}
 */
export function isStoredNodeId(nodeId) {
    return typeof nodeId === 'string' && nodeId.length > 0 && !nodeId.startsWith(PROVISIONAL_NODE_PREFIX);
}

/**
 * @param {unknown} nodeId
 * @returns {nodeId is string}
 */
export function isProvisionalNodeId(nodeId) {
    return typeof nodeId === 'string' && nodeId.startsWith(PROVISIONAL_NODE_PREFIX);
}
