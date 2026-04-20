import { invoke, Channel } from './tauri.js';

export class DeepgramClient {
  constructor() {
    this.channel = null;
    this.isConnected = false;
    this.onProvisional = null;
    this.onOriginal = null;
    this.onStatus = null;
    this.onError = null;
  }

  async connect({ sourceLanguage = 'auto', endpointDelay = 1500, strictLanguage = false }) {
    await this.disconnect();

    this.channel = new Channel();
    this.channel.onmessage = (message) => {
      const data = typeof message === 'string' ? JSON.parse(message) : message;
      this._handleMessage(data);
    };

    this._setStatus('connecting');

    await invoke('start_deepgram_stream', {
      sourceLang: sourceLanguage,
      endpointDelay,
      strictLanguage,
      channel: this.channel,
    });
  }

  async startAudioForward(source) {
    await invoke('start_capture_to_deepgram', { source });
  }

  async disconnect() {
    this.isConnected = false;
    try {
      await invoke('stop_deepgram_stream');
    } catch {}
    this._setStatus('disconnected');
    this.channel = null;
  }

  _handleMessage(data) {
    switch (data.type) {
      case 'ready':
        this.isConnected = true;
        this._setStatus('connected');
        break;
      case 'provisional':
        this.onProvisional?.(data.text || '', data.language || null, data);
        break;
      case 'original':
        this.onOriginal?.(data.text || '', data.language || null, data);
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
      default:
        break;
    }
  }

  _setStatus(status) {
    this.onStatus?.(status);
  }
}

export const deepgramClient = new DeepgramClient();
