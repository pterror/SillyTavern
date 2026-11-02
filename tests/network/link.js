import { spawnSync } from 'node:child_process';

/**
 * One-way: a round trip pays `delayMs` twice.
 * @typedef {{ name: string, delayMs: number, jitterMs: number, rateKbit: number, lossPercent: number }} LinkProfile
 */

/** @type {Record<string, LinkProfile>} */
export const PROFILES = {
    local: { name: 'local', delayMs: 0, jitterMs: 0, rateKbit: 0, lossPercent: 0 },
    '3g': { name: '3g', delayMs: 150, jitterMs: 20, rateKbit: 750, lossPercent: 0.5 },
    'phone over vpn': { name: 'phone over vpn', delayMs: 60, jitterMs: 15, rateKbit: 5000, lossPercent: 1 },
    lossy: { name: 'lossy', delayMs: 40, jitterMs: 10, rateKbit: 10000, lossPercent: 5 },
};

/**
 * @param {string[]} args
 */
function tc(args) {
    const run = spawnSync('tc', args, { encoding: 'utf8' });
    if (run.status !== 0) {
        throw new Error(`tc ${args.join(' ')} failed: ${run.stderr || run.error?.message || run.status}`);
    }
}

/** @param {LinkProfile} profile */
function netemArgs(profile) {
    const args = ['netem', 'limit', '100000'];
    if (profile.delayMs > 0) {
        args.push('delay', `${profile.delayMs}ms`);
        if (profile.jitterMs > 0) args.push(`${profile.jitterMs}ms`, 'distribution', 'normal');
    }
    if (profile.rateKbit > 0) args.push('rate', `${profile.rateKbit}kbit`);
    if (profile.lossPercent > 0) args.push('loss', `${profile.lossPercent}%`);
    return args;
}

/**
 * Needs CAP_NET_ADMIN on the loopback, which `npm run test:network` gets from its own user and network namespace.
 * @param {number} port
 */
export function shapePort(port) {
    const probe = spawnSync('tc', ['qdisc', 'show', 'dev', 'lo'], { encoding: 'utf8' });
    if (probe.status !== 0) {
        throw new Error('tc is unavailable; run the network suite with `npm run test:network`');
    }
    spawnSync('tc', ['qdisc', 'del', 'dev', 'lo', 'root'], { encoding: 'utf8' });
    tc(['qdisc', 'add', 'dev', 'lo', 'root', 'handle', '1:', 'prio', 'bands', '4', 'priomap', ...'1 2 2 2 1 2 0 0 1 1 1 1 1 1 1 1'.split(' ')]);
    tc(['qdisc', 'add', 'dev', 'lo', 'parent', '1:4', 'handle', '40:', ...netemArgs(PROFILES.local)]);
    for (const side of ['dport', 'sport']) {
        tc(['filter', 'add', 'dev', 'lo', 'parent', '1:', 'protocol', 'ip', 'prio', '1', 'u32', 'match', 'ip', side, String(port), '0xffff', 'flowid', '1:4']);
    }
}

/** @param {LinkProfile} profile */
export function setLink(profile) {
    tc(['qdisc', 'change', 'dev', 'lo', 'parent', '1:4', 'handle', '40:', ...netemArgs(profile)]);
}
