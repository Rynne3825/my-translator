# Verification Checklist

## Build
- [ ] `npm install` thanh cong.
- [ ] `cargo check` trong `src-tauri` thanh cong.
- [ ] `npm run tauri dev` launch duoc app.

## Audio + STT
- [ ] Source = system: co transcript.
- [ ] Source = microphone: co transcript.
- [ ] Source = both: co transcript.
- [ ] Deepgram provisional/original cap nhat on dinh.

## Translation
- [ ] Azure one-way cho cap ngon ngu mong muon.
- [ ] UI chi hien thi ban dich.
- [ ] Khong con code path local model.

## TTS
- [ ] Edge TTS doc duoc translation.
- [ ] Azure TTS doc duoc translation.
- [ ] Tat TTS thi khong phat audio.

## History
- [ ] Stop session thi luu transcript.
- [ ] Tab History doc duoc danh sach transcript.
