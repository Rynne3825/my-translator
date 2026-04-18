<p align="center">
  <img src="docs/assets/banner.png?v=2" alt="My Translator — Real-time Speech Translation">
</p>

<p align="center">
  <img src="https://img.shields.io/github/v/release/phuc-nt/my-translator?color=green&label=release" alt="Latest Release">
  <img src="https://img.shields.io/badge/built_with-Tauri-orange?logo=tauri" alt="Built with Tauri">
  <img src="https://img.shields.io/badge/macOS-Apple%20Silicon%20%7C%20Intel-black?logo=apple" alt="macOS">
  <img src="https://img.shields.io/badge/Windows-10%2F11-blue?logo=windows" alt="Windows">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License">
  <img src="https://img.shields.io/github/stars/phuc-nt/my-translator?style=flat&color=yellow" alt="Stars">
</p>

**My Translator** is a real-time speech translation desktop app built with Tauri.
It captures audio from your system or microphone, transcribes speech, translates text, and shows results in an always-available overlay.

---

## How It Works

```
System Audio / Mic → 16kHz PCM → STT (Deepgram or Local Faster-Whisper)
              ↓
            Translation (Azure / Marian / NLLB-600M)
              ↓
            Overlay UI + optional TTS (Edge)
```

| Feature | Detail |
|---------|--------|
| **Latency** | ~2–3s |
| **Languages** | Multi-language source and target support |
| **STT** | Deepgram cloud or local Faster-Whisper |
| **Translation** | Azure Translator, Marian, NLLB-600M |
| **TTS** | Edge neural voices |
| **Platform** | macOS (ARM + Intel) · Windows |
| **Signed** | ✅ macOS signed & notarized |
| **Auto-Update** | ✅ Built-in, check & install from Settings |

---

## Features

### 📖 Dual Panel View

Two display modes:
- **Single** (default) — Translation text only, clean and focused
- **Dual** — Source | Translation side-by-side, each panel scrolls independently

Toggle with the panel button (bottom-right on hover).

### 🔄 Smart Scroll

Auto-scroll only when you're at the bottom. Scroll up to read old content without being yanked back down.

### 🔤 Quick Font Size

A- / A+ floating controls (bottom-right on hover). Font size adjustable up to 140px — great for presentations.

### 🔄 Two-Way Translation

Translate conversations between two languages simultaneously — ideal for bilingual meetings.

- **One-way**: Source language → Target language (e.g., Japanese → Vietnamese)
- **Two-way**: Language A ↔ Language B (e.g., Vietnamese ↔ Japanese) — the app detects who is speaking and translates to the other language automatically

**Setup for video calls** (Zoom, Google Meet, MS Teams):
1. Audio Source: **Both** (System + Mic)
2. Translation Type: **Two-way**
3. Set Language A and Language B

> **Note**: TTS narration is automatically disabled in two-way mode to prevent audio feedback loops (TTS output → mic recapture → re-translation).

### 🎙️ TTS Narration

Read translations aloud in one-way mode with Edge neural voices.

TTS is **OFF by default** — toggle with the TTS button or `⌘ T`.

### 📖 Custom Translation Terms

Define how domain-specific words should be translated:

```
Original sin = Tội nguyên tổ
Christ = Kitô
Pneumonia = Viêm phổi
```

Add terms in Settings → Translation → Translation terms. Great for religious, medical, or technical content.

### 🖥️ Whisper Local

Offline mode with local Whisper speech-to-text.

- **Windows**: faster-whisper + local translation stack
- **Apple Silicon**: local pipeline option available
- **No cloud STT key required**
- **First run downloads Python packages + models**

---

## Privacy

**Your audio never touches our servers — because there are none.**

- App connects **directly** to APIs you configure — no relay, no middleman
- **You own your API keys** — stored locally, never transmitted elsewhere
- **No account, no telemetry, no analytics** — zero tracking
- Transcripts saved as `.md` files locally, per session

---

## Tech Stack

- **[Tauri 2](https://tauri.app/)** — Rust backend + WebView frontend
- **[ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit)** — macOS system audio
- **[WASAPI](https://learn.microsoft.com/en-us/windows/win32/coreaudio/wasapi)** — Windows system audio
- **[cpal](https://github.com/RustAudio/cpal)** — Cross-platform microphone
- **[Deepgram](https://deepgram.com)** — Cloud STT
- **Local Faster-Whisper** — Offline STT mode
- **[Azure Translator](https://learn.microsoft.com/en-us/azure/ai-services/translator/)** — Cloud translation
- **Marian / NLLB-600M** — Local translation models
- **[Edge TTS](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/index-text-to-speech)** — Neural TTS

---

## Project Structure

Current structure overview is documented in [docs/file_structure.md](docs/file_structure.md).

---

## Quick Start

```bash
git clone https://github.com/phuc-nt/my-translator.git
cd my-translator
npm install
```

Run in development mode:

```bash
npm run tauri dev
```

Build desktop bundles:

```bash
npm run tauri build
```

Requires: Rust (stable), Node.js 18+, Python 3.10+, macOS 13+ or Windows 10+.

---

## Star History

<a href="https://www.star-history.com/?repos=phuc-nt%2Fmy-translator&type=date&legend=top-left">
 <picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/image?repos=phuc-nt/my-translator&type=date&theme=dark&legend=top-left" />
  <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/image?repos=phuc-nt/my-translator&type=date&legend=top-left" />
  <img alt="Star History Chart" src="https://api.star-history.com/image?repos=phuc-nt/my-translator&type=date&legend=top-left" />
 </picture>
</a>

---

## License

MIT
