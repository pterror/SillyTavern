import { debounce_timeout } from './constants.js';

export class DragAndDropHandler {
    /** @private @type {JQuery.Selector} */ selector;
    /** @private @type {(files: File[], event:JQuery.DropEvent<HTMLElement, undefined, any, any>) => void} */ onDropCallback;
    /** @private @type {NodeJS.Timeout} not actually a NodeJS.Timeout, but close enough */ dragLeaveTimeout;

    /** @private @type {boolean} */ noAnimation;

    constructor(selector, onDropCallback, { noAnimation = false } = {}) {
        this.selector = selector;
        this.onDropCallback = onDropCallback;
        this.dragLeaveTimeout = null;

        this.noAnimation = noAnimation;

        this.init();
    }

    destroy() {
        if (this.selector === 'body') {
            $(document.body).off('dragover', this.handleDragOver.bind(this));
            $(document.body).off('dragleave', this.handleDragLeave.bind(this));
            $(document.body).off('drop', this.handleDrop.bind(this));
        } else {
            $(document.body).off('dragover', this.selector, this.handleDragOver.bind(this));
            $(document.body).off('dragleave', this.selector, this.handleDragLeave.bind(this));
            $(document.body).off('drop', this.selector, this.handleDrop.bind(this));
        }

        $(this.selector).remove('drop_target no_animation');
    }

    /** @private */
    init() {
        if (this.selector === 'body') {
            $(document.body).on('dragover', this.handleDragOver.bind(this));
            $(document.body).on('dragleave', this.handleDragLeave.bind(this));
            $(document.body).on('drop', this.handleDrop.bind(this));
        } else {
            $(document.body).on('dragover', this.selector, this.handleDragOver.bind(this));
            $(document.body).on('dragleave', this.selector, this.handleDragLeave.bind(this));
            $(document.body).on('drop', this.selector, this.handleDrop.bind(this));
        }

        $(this.selector).addClass('drop_target');
        if (this.noAnimation) $(this.selector).addClass('no_animation');
    }

    /** @private */
    handleDragOver(event) {
        event.preventDefault();
        event.stopPropagation();
        clearTimeout(this.dragLeaveTimeout);
        $(this.selector).addClass('drop_target dragover');
        if (this.noAnimation) $(this.selector).addClass('no_animation');
    }

    /** @private */
    handleDragLeave(event) {
        event.preventDefault();
        event.stopPropagation();

        // Debounced so the class removal doesn't flicker while still dragging over
        clearTimeout(this.dragLeaveTimeout);
        this.dragLeaveTimeout = setTimeout(() => {
            $(this.selector).removeClass('dragover');
        }, debounce_timeout.quick);
    }

    /** @private */
    handleDrop(event) {
        event.preventDefault();
        event.stopPropagation();
        clearTimeout(this.dragLeaveTimeout);
        $(this.selector).removeClass('dragover');

        const files = Array.from(event.originalEvent.dataTransfer.files);
        this.onDropCallback(files, event);
    }
}
