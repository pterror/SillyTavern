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
     * Optional watchdog timeout (ms) - without it, a callback that never settles (e.g. a hung fetch with no
     * timeout of its own) leaves `isBusy` stuck true forever, silently no-op'ing every future `update()`.
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
        if (this.isBusy) {
            return;
        }

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
            // Avoid a disconnected unhandled-rejection if the callback settles after the watchdog already fired.
            if (!settled) {
                callbackPromise.catch(error => console.warn('SimpleMutex: callback settled after watchdog timeout', error));
            }
        }
    }
}
