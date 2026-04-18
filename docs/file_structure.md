# Cau truc du an my-translator

Tai lieu nay mo ta cau truc hien tai sau khi da don dep de root gon va cac vung chuc nang ro rang.

---

## 1. Nhom vung chinh

- Runtime app:
   - `src/` (frontend)
   - `src-tauri/` (backend Tauri/Rust)
- Tooling local:
   - `scripts/` (python sidecar va setup)
- Tai lieu va tai nguyen:
   - `docs/`
- Test script thu cong:
   - `tools/tests/`

---

## 2. Cay thu muc rut gon

```text
my-translator/
|- .github/
|- .vscode/
|- docs/
|  |- assets/
|  |  |- banner.png
|  |- research/
|  |  |- translabuddy.com.har
|  |- style-lab/
|  |  |- base_crystal_ball.css
|  |  |- base_crystal_ball_clean.css
|  |  \- css_extracted.css
|  |- file_structure.md
|  |- future-plans.md
|  |- installation_guide.md
|  |- installation_guide_vi.md
|  |- installation_guide_win.md
|  |- installation_guide_win_vi.md
|  |- tts_guide.md
|  \- tts_guide_vi.md
|- scripts/
|  |- runtime/
|  |  \- local_whisper_pipeline.py
|  |- setup/
|  |  |- setup_local_whisper.py
|  \- translate/
|     \- text_translate.py
|- src/
|  |- index.html
|  |- js/
|  |  |- app.js
|  |  |- audio-player.js
|  |  |- deepgram.js
|  |  |- edge-tts.js
|  |  |- i18n.js
|  |  |- settings.js
|  |  |- ui.js
|  |  \- updater.js
|  \- styles/
|     |- main.css
|     \- translabuddy.css
|- src-tauri/
|  |- capabilities/
|  |- icons/
|  |- src/
|  |- Cargo.toml
|  \- tauri.conf.json
|- tools/
|  \- tests/
|     |- test_azure.py
|     |- test_azure2.py
|     |- test_azure3.py
|     \- test_final.py
|- LICENSE
|- README.md
|- package.json
\- package-lock.json
```

---

## 3. Quy uoc de giu cau truc gon

- Khong dat file thu nghiem moi o root.
- File tai nguyen tai lieu dua vao `docs/assets/`.
- Artifact debug lon (HAR, dump) dua vao `docs/research/`.
- CSS/PoC de tham khao dua vao `docs/style-lab/`.
- Script test thu cong dua vao `tools/tests/`.
- Runtime code chi nam trong `src/`, `src-tauri/`, `scripts/`.

---

## 4. Ghi chu van hanh

- `node_modules/` va `src-tauri/target/` la thu muc sinh tu dong, khong can quan ly nhu source code chinh.
- Tauri bundle dang copy script python tu `scripts/*`; vi vay can giu cac file sidecar runtime o cap thu muc `scripts/`.
