import { throttle } from './utils.js';

export function initDomHandlers() {
    handleInputWheel();
}

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

        let newValue = currentValue + (deltaY > 0 ? -step : step);
        newValue = Math.round(newValue / step) * step;
        newValue = !isNaN(min) ? Math.max(newValue, min) : newValue;
        newValue = !isNaN(max) ? Math.min(newValue, max) : newValue;
        newValue = Math.round(newValue * 1e10) / 1e10;

        input.value = newValue.toString();
        if (slider) slider.value = newValue.toString();
        const inputEvent = new Event('input', { bubbles: true });
        input.dispatchEvent(inputEvent);
    }

    const updateValueThrottled = throttle(updateValue, minInterval);

    document.addEventListener('wheel', (e) => {
        const input = document.activeElement instanceof HTMLInputElement ? document.activeElement : null;
        if (input && input.type === 'number' && input.hasAttribute('step') && !input.closest('[data-field]')) {
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
