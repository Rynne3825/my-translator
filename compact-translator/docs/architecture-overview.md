# Compact Translator Architecture

## Muc tieu
Ung dung desktop toi gian phuc vu demo va bao cao luong xu ly theo thoi gian thuc:
- Audio input: system / microphone / both
- STT: Deepgram realtime
- TTT: Azure Translator one-way
- TTS: Edge hoac Azure
- UI: Main + History

## Thanh phan
1. Frontend (`src/`)
- `src/js/app.js`: dieu phoi luong chay Start/Stop, queue dich, hien thi translation-only.
- `src/js/deepgram-client.js`: ket noi Deepgram va nhan event transcript.
- `src/js/tts-service.js`: chon provider TTS (Edge/Azure) va phat audio.
- `src/js/audio-player.js`: queue playback.
- `src/js/settings.js`: load/save settings.

2. Backend (`src-tauri/src/`)
- `commands/audio.rs`: bat audio source va stream PCM.
- `commands/deepgram.rs`: websocket realtime STT.
- `commands/azure_speech.rs`: azure_translate_text + azure_tts_speak.
- `commands/edge_tts.rs`: Edge TTS websocket proxy.
- `commands/transcript.rs`: save/list/open transcript.
- `settings.rs`: schema va persistence settings.

## Luong tong quan
1. User nhan Start.
2. App mo Deepgram stream.
3. Audio duoc forward vao Deepgram.
4. Deepgram tra provisional/original transcript.
5. App dua final transcript vao queue dich Azure.
6. UI hien thi ban dich (khong hien thi ban goc).
7. Neu TTS bat, app doc ban dich bang Edge/Azure.
8. Stop -> save transcript -> cap nhat History.
