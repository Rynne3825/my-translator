# TTS Flow (Edge / Azure)

## Scope
- Co 2 provider: Edge, Azure.
- Bat/tat boi `tts_enabled`.

## Runtime sequence
1. Sau khi co translated text, frontend goi `speakText`.
2. Neu provider = `edge` -> goi `edge_tts_speak`.
3. Neu provider = `azure` -> goi `azure_tts_speak`.
4. Backend tra base64 audio.
5. Frontend dua vao `audio-player` de queue va phat lien mach.

## Error handling
- Neu TTS loi, app van tiep tuc STT/TTT.
- Khong de loi TTS lam dung toan bo session.
