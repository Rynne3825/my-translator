const { invoke, Channel } = window.__TAURI__.core;

export class DeepgramClient {
    constructor() {
        this.channel = null;
        this.isConnected = false;
        this.onOriginal = null;
        this.onProvisional = null;
        this.onStatusChange = null;
        this.onError = null;
        this.onConfidence = null;
    }

    async connect(config) {
        await this.disconnect();
        this.channel = new Channel();
        this.channel.onmessage = (message) => {
            const data = typeof message === 'string' ? JSON.parse(message) : message;
            this._handleMessage(data);
        };

        this._setStatus('connecting');
        await invoke('start_deepgram_stream', {
            sourceLang: config.sourceLanguage || 'auto',
            endpointDelay: config.endpointDelay || 3000,
            channel: this.channel,
        });
    }

    async sendAudio(pcmData) {
        if (!this.channel) return;
        await invoke('send_audio_to_deepgram', { data: Array.from(new Uint8Array(pcmData)) });
    }

    async disconnect() {
        this.isConnected = false;
        if (this.channel) {
            try {
                await invoke('stop_deepgram_stream');
            } catch {}
            this.channel = null;
        }
        this._setStatus('disconnected');
    }

    _handleMessage(data) {
        switch (data.type) {
            case 'ready':
                this.isConnected = true;
                this._setStatus('connected');
                break;
            case 'provisional':
                this.onProvisional?.(data.text || '', null, data.language ?? null, data);
                if (data.confidence !== undefined && data.confidence !== null) {
                    this.onConfidence?.(data.confidence);
                }
                break;
            case 'original':
                this.onOriginal?.(data.text || '', null, data.language ?? null, data);
                if (data.confidence !== undefined && data.confidence !== null) {
                    this.onConfidence?.(data.confidence);
                }
                break;
            case 'error':
                this.isConnected = false;
                this._setStatus('error');
                this.onError?.(data.message || 'Deepgram error');
                break;
            case 'done':
                this.isConnected = false;
                this._setStatus('disconnected');
                break;
            case 'status':
                this._setStatus(data.message || 'connecting');
                break;
        }
    }

    _setStatus(status) {
        this.onStatusChange?.(status);
    }
}

export const deepgramClient = new DeepgramClient();
