import { throttle } from './utils.js';

export function initDomHandlers() {
    handleInputWheel();
}

/** Traps wheel events on focused number inputs so scrolling updates the value instead of the page (also fixes wheel not working on these inputs in Firefox). */
function handleInputWheel() {
    const minInterval = 25; // ms

    /**
     * @param {HTMLInputElement} input
     * @param {HTMLInputElement|null} slider
     * @param {number} deltaY
     */
    function updateValue(input, slider, deltaY) {
        const currentValue = parseFloat(input.value);
        const step = parseFloat(input.step);
        const min = parseFloat(input.min);
        const max = parseFloat(input.max);

        if (isNaN(currentValue) || isNaN(step) || step <= 0 || deltaY === 0) return;

        // deltaY negative = wheel up
        let newValue = currentValue + (deltaY > 0 ? -step : step);
        newValue = Math.round(newValue / step) * step;
        newValue = !isNaN(min) ? Math.max(newValue, min) : newValue;
        newValue = !isNaN(max) ? Math.min(newValue, max) : newValue;
        newValue = Math.round(newValue * 1e10) / 1e10; // avoid float precision drift

        input.value = newValue.toString();
        if (slider) slider.value = newValue.toString();
        // dispatch once, not per wheel tick, so listeners aren't flooded
        const inputEvent = new Event('input', { bubbles: true });
        input.dispatchEvent(inputEvent);
    }

    const updateValueThrottled = throttle(updateValue, minInterval);

    document.addEventListener('wheel', (e) => {
        const input = document.activeElement instanceof HTMLInputElement ? document.activeElement : null;
        if (input && input.type === 'number' && input.hasAttribute('step')) {
            const parent = input.closest('.range-block-range-and-counter') ?? input.closest('div') ?? input.parentElement;
            const slider = /** @type {HTMLInputElement} */ (parent?.querySelector('input[type="range"]'));

            if (e.target === input || (slider && e.target === slider)) {
                e.stopPropagation();
                e.preventDefault();

                updateValueThrottled(input, slider, e.deltaY);
            }
        }
    }, { passive: false });
}
