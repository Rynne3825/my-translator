# STT Flow (Deepgram)

## Input
- Audio source: `system`, `microphone`, hoac `both`.
- Format runtime: PCM s16le 16kHz mono.

## Runtime sequence
1. Frontend goi `start_deepgram_stream`.
2. Backend tao token Deepgram va mo websocket.
3. Frontend goi `start_capture_to_deepgram`.
4. Backend doc audio chunks va gui message binary len websocket.
5. Deepgram tra event:
- `provisional`: transcript tam de cap nhat nhanh UI.
- `original`: transcript da final de dua sang dich.
- `error` / `done`: dung stream va thong bao trang thai.

## Output sang TTT
- Text final (`original`) + language detect (neu co) duoc day vao queue dich Azure.

## Error handling
- Khong co Deepgram key: fail-fast truoc khi start.
- Timeout websocket: tra message loi ro rang.
- Audio send fail: emit error va stop session.
