const IGNORED = [/\/api\/characters\/changes\/stream/, /^data:/, /^blob:/];
const SAME_TIME_MS = 2;
const QUIET_MS = 500;
const SETTLE_CAP_MS = 20000;

/**
 * @typedef {{ method: string, path: string, start: number, end: number | null, sent: number, received: number, status: number | null, failed: string | null, depth: number }} TracedRequest
 * @typedef {{ action: string, profile: string, inputAt: number, visibleAt: number | null, visibleMs: number | null, requests: TracedRequest[], beforeVisible: number, roundTrips: number, criticalPath: TracedRequest[], sent: number, received: number }} ActionTrace
 */

/**
 * @param {TracedRequest[]} requests
 */
function markDepths(requests) {
    const ordered = [...requests].sort((a, b) => a.start - b.start);
    for (const r of ordered) {
        const before = ordered.filter(q => q !== r && q.end !== null && q.end <= r.start + SAME_TIME_MS);
        r.depth = 1 + before.reduce((max, q) => Math.max(max, q.depth), 0);
    }
    let tail = ordered.reduce((best, r) => (best === null || r.depth > best.depth ? r : best), /** @type {TracedRequest | null} */ (null));
    const chain = [];
    while (tail) {
        chain.unshift(tail);
        const at = tail;
        tail = ordered
            .filter(q => q.depth === at.depth - 1 && q.end !== null && q.end <= at.start + SAME_TIME_MS)
            .sort((a, b) => /** @type {number} */ (b.end) - /** @type {number} */ (a.end))[0] ?? null;
    }
    return chain;
}

/**
 * `act` must be a real pointer or key input: the action's start is that input's event time.
 * @param {import('@playwright/test').Page} page
 * @param {{ action: string, profile: string, act: () => Promise<void>, visible: { selector: string, text?: string } }} options
 * @returns {Promise<ActionTrace>}
 */
export async function traceAction(page, { action, profile, act, visible }) {
    /** @type {Map<import('@playwright/test').Request, TracedRequest>} */
    const seen = new Map();
    let lastEvent = Date.now();
    let inFlight = 0;
    const onRequest = (/** @type {import('@playwright/test').Request} */ request) => {
        if (IGNORED.some(re => re.test(request.url()))) return;
        const url = new URL(request.url());
        seen.set(request, { method: request.method(), path: url.pathname + url.search, start: Date.now(), end: null, sent: 0, received: 0, status: null, failed: null, depth: 0 });
        inFlight++;
        lastEvent = Date.now();
    };
    const onDone = async (/** @type {import('@playwright/test').Request} */ request, /** @type {string | null} */ failed) => {
        const traced = seen.get(request);
        if (!traced) return;
        const timing = request.timing();
        if (timing.startTime > 0) {
            traced.start = timing.startTime;
            traced.end = timing.responseEnd >= 0 ? timing.startTime + timing.responseEnd : Date.now();
        } else {
            traced.end = Date.now();
        }
        traced.failed = failed;
        try {
            const sizes = await request.sizes();
            traced.sent = sizes.requestHeadersSize + sizes.requestBodySize;
            traced.received = sizes.responseHeadersSize + sizes.responseBodySize;
            traced.status = (await request.response())?.status() ?? null;
        } catch {
            traced.status = null;
        }
        inFlight--;
        lastEvent = Date.now();
    };
    const onFinished = (/** @type {import('@playwright/test').Request} */ r) => void onDone(r, null);
    const onFailed = (/** @type {import('@playwright/test').Request} */ r) => void onDone(r, r.failure()?.errorText ?? 'failed');

    await page.evaluate(({ selector, text }) => {
        const w = /** @type {any} */ (window);
        w.__trace = { inputAt: null, visibleAt: null };
        const at = () => performance.timeOrigin + performance.now();
        const onInput = (/** @type {Event} */ event) => {
            if (w.__trace.inputAt === null) w.__trace.inputAt = performance.timeOrigin + event.timeStamp;
        };
        for (const type of ['pointerdown', 'keydown']) addEventListener(type, onInput, { capture: true, once: true });
        const matches = () => [...document.querySelectorAll(selector)].some(el => text === undefined || (el.textContent ?? '').includes(text));
        const observer = new MutationObserver(() => {
            if (w.__trace.inputAt !== null && w.__trace.visibleAt === null && matches()) {
                w.__trace.visibleAt = at();
                observer.disconnect();
            }
        });
        observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
        w.__traceObserver = observer;
    }, visible);

    page.on('request', onRequest);
    page.on('requestfinished', onFinished);
    page.on('requestfailed', onFailed);
    try {
        await act();
        await page.waitForFunction(() => /** @type {any} */ (window).__trace.visibleAt !== null, undefined, { timeout: SETTLE_CAP_MS });
        const settleBy = Date.now() + SETTLE_CAP_MS;
        while (Date.now() < settleBy && (inFlight > 0 || Date.now() - lastEvent < QUIET_MS)) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }
    } finally {
        page.off('request', onRequest);
        page.off('requestfinished', onFinished);
        page.off('requestfailed', onFailed);
        await page.evaluate(() => /** @type {any} */ (window).__traceObserver?.disconnect()).catch(() => {});
    }
    const marks = await page.evaluate(() => /** @type {any} */ (window).__trace);
    const inputAt = marks.inputAt ?? Date.now();
    const requests = [...seen.values()].filter(r => r.start >= inputAt - SAME_TIME_MS);
    const criticalPath = markDepths(requests);
    const visibleAt = marks.visibleAt;
    const beforeVisible = visibleAt === null ? requests.length : requests.filter(r => r.start <= visibleAt).length;
    return {
        action,
        profile,
        inputAt,
        visibleAt,
        visibleMs: visibleAt === null ? null : Math.round(visibleAt - inputAt),
        requests: requests.sort((a, b) => a.start - b.start),
        beforeVisible,
        roundTrips: criticalPath.length,
        criticalPath,
        sent: requests.reduce((n, r) => n + r.sent, 0),
        received: requests.reduce((n, r) => n + r.received, 0),
    };
}

/**
 * @param {ActionTrace} trace
 */
export function describeTrace(trace) {
    const lines = [`${trace.profile} | ${trace.action}: visible after ${trace.visibleMs ?? '—'} ms; ${trace.requests.length} request(s), ${trace.beforeVisible} before visible; ${trace.roundTrips} round trip(s) in sequence; ${trace.sent} B sent, ${trace.received} B received`];
    for (const r of trace.requests) {
        const took = r.end === null ? 'unfinished' : `${Math.round(r.end - r.start)} ms`;
        const onPath = trace.criticalPath.includes(r) ? '*' : ' ';
        lines.push(`  ${onPath} [rt ${r.depth}] +${Math.round(r.start - trace.inputAt)} ms ${r.method} ${r.path} -> ${r.failed ?? r.status} (${took}, ${r.sent}/${r.received} B)`);
    }
    return lines.join('\n');
}
