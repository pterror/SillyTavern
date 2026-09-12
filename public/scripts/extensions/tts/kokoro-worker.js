/** @type {import('./lib/kokoro.web.js').KokoroTTS} */
let tts = null;
/** @type {boolean} */
let ready = false;
/** @type {string[]} */
let voices = [];

self.onmessage = async function (e) {
    const { action, data } = e.data;

    switch (action) {
        case 'initialize':
            try {
                const result = await initializeTts(data);
                self.postMessage({
                    action: 'initialized',
                    success: result,
                    voices,
                });
            } catch (error) {
                self.postMessage({
                    action: 'initialized',
                    success: false,
                    error: error.message,
                });
            }
            break;

        case 'generateTts':
            try {
                const audioBlob = await generateTts(data.text, data.voice, data.speakingRate);
                const blobUrl = URL.createObjectURL(audioBlob);
                self.postMessage({
                    action: 'generatedTts',
                    success: true,
                    blobUrl,
                    requestId: data.requestId,
                });
            } catch (error) {
                self.postMessage({
                    action: 'generatedTts',
                    success: false,
                    error: error.message,
                    requestId: data.requestId,
                });
            }
            break;

        case 'checkReady':
            self.postMessage({ action: 'readyStatus', ready });
            break;
    }
};

async function initializeTts(settings) {
    try {
        const { KokoroTTS } = await import('./lib/kokoro.web.js');

        console.log('Worker: Initializing Kokoro TTS with settings:', {
            modelId: settings.modelId,
            dtype: settings.dtype,
            device: settings.device,
        });

        tts = await KokoroTTS.from_pretrained(settings.modelId, {
            dtype: settings.dtype,
            device: settings.device,
        });

        voices = Object.keys(tts.voices);

        if (typeof tts.generate !== 'function') {
            throw new Error('TTS instance does not have generate method');
        }

        console.log('Worker: TTS initialized successfully');
        ready = true;
        return true;
    } catch (error) {
        console.error('Worker: Kokoro TTS initialization failed:', error);
        ready = false;
        throw error;
    }
}

async function generateTts(text, voiceId, speakingRate) {
    if (!ready || !tts) {
        throw new Error('TTS engine not initialized');
    }

    if (text.trim().length === 0) {
        throw new Error('Empty text');
    }

    try {
        const audio = await tts.generate(text, {
            voice: voiceId,
            speed: speakingRate || 1.0,
        });

        return audio.toBlob();
    } catch (error) {
        console.error('Worker: TTS generation failed:', error);
        throw error;
    }
}
