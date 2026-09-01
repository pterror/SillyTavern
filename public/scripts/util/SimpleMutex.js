/**
 * A simple mutex class to prevent concurrent updates.
 */
export class SimpleMutex {
    /**
     * @type {boolean}
     */
    isBusy = false;

    /**
     * @type {Function}
     */
    callback = () => {};

    /**
     * Optional watchdog timeout (ms). If the callback never settles (e.g. a
     * fetch call that hangs forever with no AbortController/timeout of its
     * own, which can happen after a laptop sleep/wake or a dropped
     * connection during a long-running tab), `isBusy` would otherwise stay
     * `true` forever and every future `update()` call would silently no-op
     * for the rest of the session. When set, a callback that outlives this
     * timeout has the lock force-released (with a console warning) so
     * subsequent updates can proceed again.
     * @type {number}
     */
    timeout = 0;

    /**
     * Constructs a SimpleMutex.
     * @param {Function} callback Callback function.
     * @param {number} [timeout] Optional watchdog timeout in ms. 0 (default) disables the watchdog, matching legacy behavior.
     */
    constructor(callback, timeout = 0) {
        this.isBusy = false;
        this.callback = callback;
        this.timeout = timeout;
    }

    /**
     * Updates the mutex by calling the callback if not busy.
     * @param  {...any} args Callback args
     * @returns {Promise<void>}
     */
    async update(...args) {
        // Don't touch me I'm busy...
        if (this.isBusy) {
            return;
        }

        // I'm free. Let's update!
        this.isBusy = true;

        if (!(this.timeout > 0)) {
            // Watchdog disabled: preserve the original, unmodified behavior.
            try {
                await this.callback(...args);
            } finally {
                this.isBusy = false;
            }
            return;
        }

        let timeoutId;
        let settled = false;
        const callbackPromise = Promise.resolve().then(() => this.callback(...args));
        callbackPromise.then(() => { settled = true; }, () => { settled = true; });
        const timeoutPromise = new Promise((_resolve, reject) => {
            timeoutId = setTimeout(() => reject(new Error(`SimpleMutex: callback did not settle within ${this.timeout}ms`)), this.timeout);
        });
        try {
            await Promise.race([callbackPromise, timeoutPromise]);
        } catch (error) {
            console.warn('SimpleMutex: callback failed or timed out, releasing lock', error);
        } finally {
            clearTimeout(timeoutId);
            this.isBusy = false;
            // If the callback eventually settles (successfully or not) after the watchdog
            // already fired, log it instead of letting it surface as a confusing,
            // disconnected unhandled rejection.
            if (!settled) {
                callbackPromise.catch(error => console.warn('SimpleMutex: callback settled after watchdog timeout', error));
            }
        }
    }
}
