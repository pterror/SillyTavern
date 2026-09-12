import { formatTime } from './utils.js';

export class AudioPlayer {
    constructor(audioElement, containerElement, options = {}) {
        if (!(audioElement instanceof HTMLAudioElement)) {
            throw new Error('First argument must be an HTMLAudioElement');
        }
        if (!(containerElement instanceof HTMLElement)) {
            throw new Error('Second argument must be an HTMLElement');
        }

        this.audio = audioElement;
        this.container = containerElement;
        this.options = {
            title: '',
            autoplay: false,
            volume: 1.0,
            onPlay: null,
            onPause: null,
            onEnded: null,
            onTimeUpdate: null,
            onVolumeChange: null,
            ...options,
        };

        this.isDragging = false;
        this.isDestroyed = false;

        this.boundHandlers = {
            audioLoadedMetadata: this.onAudioLoadedMetadata.bind(this),
            audioTimeUpdate: this.onAudioTimeUpdate.bind(this),
            audioPlay: this.onAudioPlay.bind(this),
            audioPause: this.onAudioPause.bind(this),
            audioEnded: this.onAudioEnded.bind(this),
            audioVolumeChange: this.onAudioVolumeChange.bind(this),
            playPauseClick: this.onPlayPauseClick.bind(this),
            volumeClick: this.onVolumeClick.bind(this),
            volumeInput: this.onVolumeInput.bind(this),
            progressMouseDown: this.onProgressMouseDown.bind(this),
            progressClick: this.onProgressClick.bind(this),
            progressMouseMove: this.onProgressMouseMove.bind(this),
            documentMouseMove: this.onDocumentMouseMove.bind(this),
            documentMouseUp: this.onDocumentMouseUp.bind(this),
        };

        this.observer = null;

        this.init();
    }

    init() {
        this.findElements();
        this.bindEvents();
        this.setupDOMObserver();

        if (this.options.title) {
            this.setTitle(this.options.title);
        } else if (this.audio.title) {
            this.setTitle(this.audio.title);
        } else if (this.audio.src) {
            const srcParts = this.audio.src.split('/');
            this.setTitle(decodeURIComponent(srcParts[srcParts.length - 1]));
        }

        if (this.options.autoplay) {
            this.play();
        }

        this.setVolume(this.options.volume);

        this.updateTimeDisplays();
    }

    findElements() {
        this.elements = {
            title: this.container.querySelector('.audio-player-title'),
            playPauseBtn: this.container.querySelector('.audio-player-play-pause'),
            currentTime: this.container.querySelector('.audio-player-current-time'),
            totalTime: this.container.querySelector('.audio-player-total-time'),
            progress: this.container.querySelector('.audio-player-progress'),
            progressBar: this.container.querySelector('.audio-player-progress-bar'),
            volumeBtn: this.container.querySelector('.audio-player-volume'),
        };

        const requiredElements = ['playPauseBtn', 'currentTime', 'totalTime', 'progress', 'progressBar', 'volumeBtn'];
        for (const key of requiredElements) {
            if (!this.elements[key]) {
                console.warn(`AudioPlayer: Required element .audio-player-${key.replace(/([A-Z])/g, '-$1').toLowerCase()} not found`);
            }
        }
    }

    setupDOMObserver() {
        this.observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                for (const node of mutation.removedNodes) {
                    if (node === this.audio || node === this.container ||
                        node.contains?.(this.audio) || node.contains?.(this.container)) {
                        this.destroy();
                        return;
                    }
                }
            }
        });

        const chatParent = this.audio.closest('#chat') ?? document.body;

        if (chatParent) {
            this.observer.observe(chatParent, { childList: true, subtree: true });
        }
    }

    bindEvents() {
        this.audio.addEventListener('loadedmetadata', this.boundHandlers.audioLoadedMetadata);
        this.audio.addEventListener('timeupdate', this.boundHandlers.audioTimeUpdate);
        this.audio.addEventListener('play', this.boundHandlers.audioPlay);
        this.audio.addEventListener('pause', this.boundHandlers.audioPause);
        this.audio.addEventListener('ended', this.boundHandlers.audioEnded);
        this.audio.addEventListener('volumechange', this.boundHandlers.audioVolumeChange);

        if (this.elements.playPauseBtn) {
            this.elements.playPauseBtn.addEventListener('click', this.boundHandlers.playPauseClick);
        }
        if (this.elements.volumeBtn) {
            this.elements.volumeBtn.addEventListener('click', this.boundHandlers.volumeClick);
        }
        if (this.elements.progress) {
            this.elements.progress.addEventListener('mousedown', this.boundHandlers.progressMouseDown);
            this.elements.progress.addEventListener('click', this.boundHandlers.progressClick);
            this.elements.progress.addEventListener('mousemove', this.boundHandlers.progressMouseMove);
        }
    }

    unbindEvents() {
        this.audio.removeEventListener('loadedmetadata', this.boundHandlers.audioLoadedMetadata);
        this.audio.removeEventListener('timeupdate', this.boundHandlers.audioTimeUpdate);
        this.audio.removeEventListener('play', this.boundHandlers.audioPlay);
        this.audio.removeEventListener('pause', this.boundHandlers.audioPause);
        this.audio.removeEventListener('ended', this.boundHandlers.audioEnded);
        this.audio.removeEventListener('volumechange', this.boundHandlers.audioVolumeChange);

        if (this.elements.playPauseBtn) {
            this.elements.playPauseBtn.removeEventListener('click', this.boundHandlers.playPauseClick);
        }
        if (this.elements.volumeBtn) {
            this.elements.volumeBtn.removeEventListener('click', this.boundHandlers.volumeClick);
        }
        if (this.elements.progress) {
            this.elements.progress.removeEventListener('mousedown', this.boundHandlers.progressMouseDown);
            this.elements.progress.removeEventListener('click', this.boundHandlers.progressClick);
            this.elements.progress.removeEventListener('mousemove', this.boundHandlers.progressMouseMove);
        }

        document.removeEventListener('mousemove', this.boundHandlers.documentMouseMove);
        document.removeEventListener('mouseup', this.boundHandlers.documentMouseUp);
    }

    onAudioLoadedMetadata() {
        if (this.isDestroyed) return;
        this.updateTimeDisplays();
    }

    onAudioTimeUpdate() {
        if (this.isDestroyed || this.isDragging) return;

        const percent = (this.audio.currentTime / this.audio.duration) * 100 || 0;
        if (this.elements.progressBar) {
            /** @type {HTMLElement} */ (this.elements.progressBar).style.width = percent + '%';
        }
        if (this.elements.currentTime) {
            this.elements.currentTime.textContent = formatTime(this.audio.currentTime);
        }

        if (typeof this.options.onTimeUpdate === 'function') {
            this.options.onTimeUpdate.call(this, this.audio.currentTime, this.audio.duration);
        }
    }

    onAudioPlay() {
        if (this.isDestroyed) return;

        if (this.elements.playPauseBtn) {
            this.elements.playPauseBtn.classList.remove('fa-play');
            this.elements.playPauseBtn.classList.add('fa-pause');
            this.elements.playPauseBtn.setAttribute('title', 'Pause');
        }

        if (typeof this.options.onPlay === 'function') {
            this.options.onPlay.call(this);
        }
    }

    onAudioPause() {
        if (this.isDestroyed) return;

        if (this.elements.playPauseBtn) {
            this.elements.playPauseBtn.classList.remove('fa-pause');
            this.elements.playPauseBtn.classList.add('fa-play');
            this.elements.playPauseBtn.setAttribute('title', 'Play');
        }

        if (typeof this.options.onPause === 'function') {
            this.options.onPause.call(this);
        }
    }

    onAudioEnded() {
        if (this.isDestroyed) return;

        if (this.elements.playPauseBtn) {
            this.elements.playPauseBtn.classList.remove('fa-pause');
            this.elements.playPauseBtn.classList.add('fa-play');
            this.elements.playPauseBtn.setAttribute('title', 'Play');
        }

        if (typeof this.options.onEnded === 'function') {
            this.options.onEnded.call(this);
        }
    }

    onAudioVolumeChange() {
        if (this.isDestroyed) return;

        this.updateVolumeIcon();

        if (typeof this.options.onVolumeChange === 'function') {
            this.options.onVolumeChange.call(this, this.audio.volume, this.audio.muted);
        }
    }

    onPlayPauseClick(e) {
        e.preventDefault();
        this.togglePlay();
    }

    onVolumeClick(e) {
        e.preventDefault();
        this.toggleMute();
    }

    onVolumeInput(e) {
        if (!(e.target instanceof HTMLInputElement)) return;
        const value = parseFloat(e.target.value);
        this.setVolume(value);
    }

    onProgressMouseDown(e) {
        this.isDragging = true;
        this.updateProgress(e);
        document.addEventListener('mousemove', this.boundHandlers.documentMouseMove);
        document.addEventListener('mouseup', this.boundHandlers.documentMouseUp);
    }

    onProgressClick(e) {
        if (!this.isDragging) {
            this.updateProgress(e);
        }
    }

    onProgressMouseMove(e) {
        if (!this.isDragging) {
            this.updateProgressTitle(e);
        }
    }

    onDocumentMouseMove(e) {
        if (this.isDragging) {
            this.updateProgress(e);
        }
    }

    onDocumentMouseUp() {
        if (this.isDragging) {
            this.isDragging = false;
            document.removeEventListener('mousemove', this.boundHandlers.documentMouseMove);
            document.removeEventListener('mouseup', this.boundHandlers.documentMouseUp);
        }
    }

    updateProgress(e) {
        if (!this.elements.progress) return;

        const rect = this.elements.progress.getBoundingClientRect();
        const offsetX = e.clientX - rect.left;
        const width = rect.width;
        const percent = Math.max(0, Math.min(100, (offsetX / width) * 100));

        if (this.elements.progressBar) {
            /** @type {HTMLElement} */ (this.elements.progressBar).style.width = percent + '%';
        }

        const seekTime = (percent / 100) * this.audio.duration;
        if (isFinite(seekTime)) {
            this.audio.currentTime = seekTime;
            if (this.elements.currentTime) {
                this.elements.currentTime.textContent = formatTime(seekTime);
            }
        }
    }

    updateVolumeIcon() {
        if (!this.elements.volumeBtn) return;

        const volume = this.audio.volume;
        const isMuted = this.audio.muted;

        this.elements.volumeBtn.classList.remove('fa-volume-high', 'fa-volume-low', 'fa-volume-off', 'fa-volume-xmark');

        if (isMuted || volume === 0) {
            this.elements.volumeBtn.classList.add('fa-volume-xmark');
        } else if (volume < 0.5) {
            this.elements.volumeBtn.classList.add('fa-volume-low');
        } else {
            this.elements.volumeBtn.classList.add('fa-volume-high');
        }
    }

    updateTimeDisplays() {
        if (this.elements.currentTime) {
            this.elements.currentTime.textContent = formatTime(this.audio.currentTime || 0);
        }
        if (this.elements.totalTime) {
            this.elements.totalTime.textContent = formatTime(this.audio.duration || 0);
        }
    }

    updateProgressTitle(e) {
        if (!this.elements.progress) return;

        const rect = this.elements.progress.getBoundingClientRect();
        const offsetX = e.clientX - rect.left;
        const width = rect.width;
        const percent = Math.max(0, Math.min(100, (offsetX / width) * 100));

        this.elements.progress.setAttribute('title', formatTime((percent / 100) * this.audio.duration));
    }

    play() {
        if (this.isDestroyed) return;
        if (this.audio.paused) {
            const playPromise = this.audio.play();
            if (playPromise !== undefined) {
                playPromise.catch(error => {
                    console.error('Audio play failed:', error);
                });
            }
        }
    }

    pause() {
        if (this.isDestroyed) return;
        if (!this.audio.paused) {
            this.audio.pause();
        }
    }

    togglePlay() {
        if (this.audio.paused) {
            this.play();
        } else {
            this.pause();
        }
    }

    seek(time) {
        if (this.isDestroyed) return;
        if (isFinite(time) && time >= 0 && time <= this.audio.duration) {
            this.audio.currentTime = time;
        }
    }

    setVolume(volume) {
        if (this.isDestroyed) return;
        volume = Math.max(0, Math.min(1, volume));
        this.audio.volume = volume;

        if (volume > 0 && this.audio.muted) {
            this.audio.muted = false;
        }
    }

    mute() {
        if (this.isDestroyed) return;
        this.audio.muted = true;
    }

    unmute() {
        if (this.isDestroyed) return;
        this.audio.muted = false;
    }

    toggleMute() {
        if (this.isDestroyed) return;
        this.audio.muted = !this.audio.muted;
    }

    setSrc(src) {
        if (this.isDestroyed) return;
        this.audio.src = src;
    }

    setTitle(title) {
        if (this.isDestroyed) return;
        this.options.title = title;
        if (this.elements.title) {
            this.elements.title.textContent = title;
        }
    }

    destroy() {
        if (this.isDestroyed) return;
        this.isDestroyed = true;

        if (this.observer) {
            this.observer.disconnect();
            this.observer = null;
        }

        this.pause();
        this.audio.src = '';

        this.unbindEvents();

        this.audio = null;
        this.container = null;
        this.elements = null;
        this.options = null;
        this.boundHandlers = null;
    }
}
