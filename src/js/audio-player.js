class AudioPlayer {
  constructor() {
    this.audioContext = null;
    this.gainNode = null;
    this.volume = 0.9;
    this.queue = [];
    this.nextStartTime = 0;
    this.currentSource = null;
    this.isPlaying = false;
  }

  init() {
    if (this.audioContext) return;
    this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    this.gainNode = this.audioContext.createGain();
    this.gainNode.gain.value = this.volume;
    this.gainNode.connect(this.audioContext.destination);
  }

  async resume() {
    if (!this.audioContext) this.init();
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
  }

  async enqueue(base64Audio) {
    if (!base64Audio) return;
    await this.resume();

    const raw = atob(base64Audio);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) {
      bytes[i] = raw.charCodeAt(i);
    }

    try {
      const buffer = await this.audioContext.decodeAudioData(bytes.buffer.slice(0));
      this.queue.push(buffer);
      this._schedule();
    } catch (err) {
      console.warn('[audio] decode failed', err);
    }
  }

  _schedule() {
    if (!this.audioContext || this.queue.length === 0) {
      this.isPlaying = false;
      return;
    }

    if (this.isPlaying && this.nextStartTime > this.audioContext.currentTime + 0.1) {
      return;
    }

    const buffer = this.queue.shift();
    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gainNode || this.audioContext.destination);

    const startTime = Math.max(this.audioContext.currentTime, this.nextStartTime);
    source.start(startTime);
    this.nextStartTime = startTime + buffer.duration;
    this.currentSource = source;
    this.isPlaying = true;

    source.onended = () => {
      if (this.queue.length > 0) {
        this._schedule();
      } else {
        this.isPlaying = false;
        this.currentSource = null;
      }
    };
  }

  setVolume(volume) {
    const next = Number.isFinite(volume) ? volume : 0.9;
    this.volume = Math.min(1, Math.max(0, next));
    if (this.gainNode) {
      this.gainNode.gain.value = this.volume;
    }
  }

  stop() {
    this.queue = [];
    this.nextStartTime = 0;
    if (this.currentSource) {
      try {
        this.currentSource.stop();
      } catch {}
    }
    this.currentSource = null;
    this.isPlaying = false;
  }
}

export const audioPlayer = new AudioPlayer();
