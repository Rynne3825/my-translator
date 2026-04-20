# TTT Flow (Azure one-way)

## Scope
- Chi co one-way translation.
- Chi co Azure Translator.
- Khong local model, khong two-way.

## Runtime sequence
1. Frontend nhan final transcript.
2. Frontend xep hang dich de tranh race condition.
3. Frontend goi `azure_translate_text(text, source_lang, target_lang)`.
4. Backend build URL Azure Translator v3 va gui HTTP request.
5. Backend tra ve `{ translated, engine, model }`.
6. Frontend render translation-only len UI.

## Quy tac
- Neu `source == target` -> identity (khong goi API).
- Ho tro key1/key2 fallback.
- Validate target language bat buoc.

## Error handling
- Thieu key Azure: fail-fast.
- HTTP error: tra chi tiet status + body.
- JSON response khong hop le: tra loi parse.
