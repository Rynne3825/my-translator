#!/usr/bin/env python3
import json
import os
import re
import sys
import uuid
from urllib import error as urllib_error
from urllib import parse as urllib_parse
from urllib import request as urllib_request
import warnings
from typing import Callable

os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")


def _try_reconfigure_stream(stream: object):
    reconfigure = getattr(stream, "reconfigure", None)
    if callable(reconfigure):
        reconfigure(encoding="utf-8", errors="replace")


def _reconfigure_stdio():
    for stream_name in ("stdin", "stdout", "stderr"):
        stream = getattr(sys, stream_name, None)
        _try_reconfigure_stream(stream)


_reconfigure_stdio()


MARIAN_MODELS = {
    ("vi", "en"): "Helsinki-NLP/opus-mt-vi-en",
    ("en", "vi"): "Helsinki-NLP/opus-mt-en-vi",
}

NLLB_MODELS = {
    "nllb_600m": "facebook/nllb-200-distilled-600M",
}
NLLB_LANGUAGE_CODES = {
    "af": "afr_Latn",
    "sq": "als_Latn",
    "ar": "arb_Arab",
    "az": "azj_Latn",
    "be": "bel_Cyrl",
    "bn": "ben_Beng",
    "bg": "bul_Cyrl",
    "bs": "bos_Latn",
    "ca": "cat_Latn",
    "cs": "ces_Latn",
    "cy": "cym_Latn",
    "da": "dan_Latn",
    "de": "deu_Latn",
    "el": "ell_Grek",
    "vi": "vie_Latn",
    "en": "eng_Latn",
    "es": "spa_Latn",
    "et": "est_Latn",
    "eu": "eus_Latn",
    "fa": "pes_Arab",
    "fi": "fin_Latn",
    "fr": "fra_Latn",
    "gl": "glg_Latn",
    "gu": "guj_Gujr",
    "he": "heb_Hebr",
    "hi": "hin_Deva",
    "hr": "hrv_Latn",
    "hu": "hun_Latn",
    "id": "ind_Latn",
    "it": "ita_Latn",
    "ja": "jpn_Jpan",
    "kk": "kaz_Cyrl",
    "kn": "kan_Knda",
    "ko": "kor_Hang",
    "lt": "lit_Latn",
    "lv": "lvs_Latn",
    "mk": "mkd_Cyrl",
    "ml": "mal_Mlym",
    "mr": "mar_Deva",
    "ms": "zsm_Latn",
    "nl": "nld_Latn",
    "no": "nob_Latn",
    "pa": "pan_Guru",
    "pl": "pol_Latn",
    "pt": "por_Latn",
    "ro": "ron_Latn",
    "ru": "rus_Cyrl",
    "sk": "slk_Latn",
    "sl": "slv_Latn",
    "sr": "srp_Cyrl",
    "sw": "swh_Latn",
    "sv": "swe_Latn",
    "ta": "tam_Taml",
    "te": "tel_Telu",
    "th": "tha_Thai",
    "tl": "tgl_Latn",
    "tr": "tur_Latn",
    "uk": "ukr_Cyrl",
    "ur": "urd_Arab",
    "zh": "zho_Hans",
}


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def normalize_lang(code: str) -> str:
    if not code:
        return ""
    normalized = code.strip().lower().replace("_", "-")
    return normalized.split("-", 1)[0]


def normalize_translation_model(name: str) -> str:
    normalized = (name or "marian").strip().lower().replace("-", "_")
    if normalized in NLLB_MODELS or normalized == "azure":
        return normalized
    return "marian"


AZURE_LANGUAGE_CODES = {
    "zh": "zh-Hans",
}


def azure_language_code(code: str) -> str:
    normalized = normalize_lang(code)
    return AZURE_LANGUAGE_CODES.get(normalized, normalized)


def build_azure_translate_url(endpoint: str, source: str, target: str) -> str:
    query = {"api-version": "3.0", "to": azure_language_code(target)}
    if source and source != "auto":
        query["from"] = azure_language_code(source)

    base = endpoint.rstrip("/")
    if "cognitiveservices.azure.com" in base and not base.endswith("microsofttranslator.com"):
        return f"{base}/translator/text/v3.0/translate?{urllib_parse.urlencode(query)}"
    return f"{base}/translate?{urllib_parse.urlencode(query)}"


def collapse_repeated_words(text: str) -> str:
    return re.sub(r"\b(\w+)(?:\s+\1\b)+", r"\1", text, flags=re.IGNORECASE)


def normalize_vi_technical(text: str) -> str:
    replacements = [
        (r"\bkhông\s+phẩy\s+không\s+năm\b", "0.05"),
        (r"\bkhông\s+phẩy\s+năm\b", "0.5"),
        (r"\bmột\s+phần\s+sáu\s+mươi\b", "1/60"),
        (r"\by\s+nhân\s+ba\s+mươi\b", "y * 30"),
        (r"\bx\s+nhân\s+ba\s+mươi\b", "x * 30"),
        (r"\by\s+x\s+30\b", "y * 30"),
        (r"\bx\s+x\s+30\b", "x * 30"),
        (r"\bphantom\b", "from"),
        (r"\brandum\b", "random"),
        (r"\brandin\b", "randint"),
        (r"\brun[\s-]*in\b", "randint"),
        (r"\bruyên\s+in\b", "randint"),
        (r"\binterger\b", "integer"),
        (r"\bslip\b", "sleep"),
        (r"\bhàm\s+slip\b", "hàm sleep"),
        (r"\bnày\s+from\b", "from"),
    ]
    normalized = text
    for pattern, replacement in replacements:
        normalized = re.sub(pattern, replacement, normalized, flags=re.IGNORECASE)
    normalized = re.sub(r"\s*([*/=])\s*", r" \1 ", normalized)
    return re.sub(r"\s+", " ", normalized).strip(" ,.")


def normalize_en_technical(text: str) -> str:
    replacements = [
        (r"\bslip\b", "sleep"),
        (r"\bone\s+over\s+sixty\b", "1/60"),
        (r"\bzero\s+point\s+zero\s+five\b", "0.05"),
        (r"\bzero\s+point\s+five\b", "0.5"),
        (r"\by\s+times\s+thirty\b", "y * 30"),
        (r"\bx\s+times\s+thirty\b", "x * 30"),
    ]
    normalized = text
    for pattern, replacement in replacements:
        normalized = re.sub(pattern, replacement, normalized, flags=re.IGNORECASE)
    normalized = re.sub(r"\s*([*/=])\s*", r" \1 ", normalized)
    return re.sub(r"\s+", " ", normalized).strip(" ,.")


def normalize_input(text: str, source: str, target: str) -> tuple[str, bool]:
    normalized = re.sub(r"\s+", " ", text).strip()
    normalized = collapse_repeated_words(normalized)

    if {source, target} == {"vi", "en"}:
        if source == "vi":
            normalized = normalize_vi_technical(normalized)
        elif source == "en":
            normalized = normalize_en_technical(normalized)

    return normalized, normalized != text.strip()


def is_code_like_text(text: str) -> bool:
    lowered = text.lower()
    strong_keywords = [
        "import",
        "random",
        "randint",
        "integer",
        "sleep",
        "api",
        "tts",
        "x * 30",
        "y * 30",
    ]
    keyword_hits = sum(1 for keyword in strong_keywords if keyword in lowered)
    syntax_hits = 0
    syntax_patterns = [
        r"\bfrom\s+[a-zA-Z_][a-zA-Z0-9_]*\s+import\b",
        r"\bimport\s+[a-zA-Z_][a-zA-Z0-9_]*(?:\s*,\s*[a-zA-Z_][a-zA-Z0-9_]*)*",
        r"\b[a-zA-Z_][a-zA-Z0-9_]*\s*=\s*[^=]",
        r"\b[a-zA-Z_][a-zA-Z0-9_]*\([^)]*\)",
        r"\b[a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z_][a-zA-Z0-9_]*\b",
    ]
    for pattern in syntax_patterns:
        if re.search(pattern, text):
            syntax_hits += 1

    operator_hits = len(re.findall(r"(?:\*|/|==|!=|:=|=>)", text))
    return keyword_hits >= 2 or (keyword_hits >= 1 and (syntax_hits >= 1 or operator_hits >= 1)) or syntax_hits >= 2


def code_like_passthrough(text: str, source: str, target: str) -> str | None:
    if {source, target} != {"vi", "en"}:
        return None
    if not is_code_like_text(text):
        return None

    cleaned = text
    cleaned = re.sub(r"\b(?:này|đấy|nhé|thì|ờ|ừm)\b", " ", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\bcái này sẽ\b", "this will", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\btự động ngẫu nhiên ra một số\b", "randomly generate an", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\bquả táo\b", "apple", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" ,.")
    if not re.fullmatch(r"[A-Za-z0-9_*,.=()\[\]\s:+/\-]+", cleaned):
        return None
    return cleaned or text


def postprocess_translation(text: str, normalized_source: str, source: str, target: str) -> str:
    translated = re.sub(r"\s+", " ", text).strip()
    if not translated:
        return translated

    if source == "vi" and target == "en":
        if re.search(r"\bsleep\b", normalized_source, flags=re.IGNORECASE):
            translated = re.sub(r"\bslip\b", "sleep", translated, flags=re.IGNORECASE)
        translated = re.sub(r"\bAPI\b", "API", translated, flags=re.IGNORECASE)
        translated = re.sub(r"\bTTS\b", "TTS", translated, flags=re.IGNORECASE)

    if source == "en" and target == "vi":
        translated = re.sub(r"\bAPI\b", "API", translated, flags=re.IGNORECASE)
        translated = re.sub(r"\bTTS\b", "TTS", translated, flags=re.IGNORECASE)

    return translated


def generation_kwargs(token_count: int) -> dict:
    dynamic_max_new_tokens = max(24, min(96, int(token_count * 1.5) + 12))
    return {
        "max_new_tokens": dynamic_max_new_tokens,
        "num_beams": 1,
        "do_sample": False,
        "no_repeat_ngram_size": 3,
        "repetition_penalty": 1.1,
        "max_time": 4.0,
    }


class HFRuntime:
    def __init__(self):
        self._torch = None
        self._logging_ready = False

    def torch(self):
        if self._torch is not None:
            return self._torch

        try:
            import torch
            from transformers.utils import logging as transformers_logging
        except ImportError as exc:
            raise RuntimeError(
                "Local translation dependencies are missing. Run Faster-Whisper Realtime setup again."
            ) from exc

        if not self._logging_ready:
            warnings.filterwarnings("ignore", message=".*max_new_tokens.*max_length.*")
            warnings.filterwarnings("ignore", message=".*Both `max_new_tokens`.*")
            transformers_logging.set_verbosity_error()
            self._logging_ready = True

        torch.set_grad_enabled(False)
        self._torch = torch
        return torch


class HFPipelineBackend:
    def __init__(self, runtime: HFRuntime, model_name: str, tokenizer_loader, model_loader):
        self.runtime = runtime
        self.model_name = model_name
        self.tokenizer = tokenizer_loader(model_name)
        self.model = model_loader(model_name)
        self.model.eval()

    def translate(
        self,
        text: str,
        *,
        tokenizer_kwargs: dict | None = None,
        generation_overrides: dict | None = None,
    ) -> str:
        torch = self.runtime.torch()
        tokenizer_kwargs = tokenizer_kwargs or {}
        generation_overrides = generation_overrides or {}
        tokens = self.tokenizer(text, return_tensors="pt", truncation=True, **tokenizer_kwargs)
        kwargs = {
            **generation_kwargs(int(tokens["input_ids"].shape[-1])),
            **generation_overrides,
        }
        with torch.no_grad():
            outputs = self.model.generate(**tokens, **kwargs)
        translated = self.tokenizer.batch_decode(outputs, skip_special_tokens=True)
        return translated[0].strip() if translated else ""


class TextTranslator:
    def __init__(self):
        self.runtime = HFRuntime()
        self.marian_cache: dict[tuple[str, str], HFPipelineBackend] = {}
        self.nllb_cache: dict[str, HFPipelineBackend] = {}

    def prepare(
        self,
        source_lang: str,
        target_lang: str,
        translation_model: str,
        azure_config: dict | None = None,
    ) -> tuple[str, str]:
        source = normalize_lang(source_lang)
        target = normalize_lang(target_lang)
        selected_model = normalize_translation_model(translation_model)
        if not source or not target:
            raise RuntimeError("Source and target languages are required.")
        if source == target:
            return "identity", "identity"

        engine, model_name = self._resolve_engine(source, target, selected_model)
        if engine == "azure":
            self._validate_azure_config(azure_config)
        elif engine == "nllb":
            self._ensure_nllb(model_name, source, target)
        else:
            self._ensure_marian(source, target)
        return engine, model_name

    def translate(
        self,
        text: str,
        source_lang: str,
        target_lang: str,
        translation_model: str,
        azure_config: dict | None = None,
    ) -> dict:
        if not isinstance(text, str):
            raise TypeError("not a string")

        source = normalize_lang(source_lang)
        target = normalize_lang(target_lang)
        selected_model = normalize_translation_model(translation_model)
        raw_text = text.strip()

        if not raw_text:
            return self._identity_response("", "")
        if not source or not target:
            raise RuntimeError("Source and target languages are required.")
        if source == target:
            return self._identity_response(raw_text, raw_text)

        normalized_text, normalization_applied = normalize_input(raw_text, source, target)
        passthrough = code_like_passthrough(normalized_text, source, target)
        if passthrough is not None:
            return {
                "translated": passthrough,
                "engine": "identity",
                "model": "code_passthrough",
                "normalized_text": normalized_text,
                "normalization_applied": normalization_applied,
            }

        engine, model_name = self._resolve_engine(source, target, selected_model)
        if engine == "azure":
            translated = self._translate_azure(normalized_text, source, target, azure_config)
        elif engine == "nllb":
            translated = self._ensure_nllb(model_name, source, target)(normalized_text)
        else:
            translated = self._ensure_marian(source, target)(normalized_text)

        return {
            "translated": postprocess_translation(translated, normalized_text, source, target),
            "engine": engine,
            "model": model_name,
            "normalized_text": normalized_text,
            "normalization_applied": normalization_applied,
        }

    def _identity_response(self, translated: str, normalized_text: str) -> dict:
        return {
            "translated": translated,
            "engine": "identity",
            "model": "identity",
            "normalized_text": normalized_text,
            "normalization_applied": False,
        }

    def _resolve_engine(self, source: str, target: str, selected_model: str) -> tuple[str, str]:
        if selected_model == "azure":
            return "azure", "azure-translator-v3"

        if source == "auto":
            source = "en"

        pair = (source, target)
        if pair in MARIAN_MODELS:
            if selected_model in NLLB_MODELS:
                if source not in NLLB_LANGUAGE_CODES or target not in NLLB_LANGUAGE_CODES:
                    raise RuntimeError(f"{NLLB_MODELS[selected_model]} is unavailable for {source} -> {target}.")
                return "nllb", NLLB_MODELS[selected_model]
            return "marian", MARIAN_MODELS[pair]

        if source in NLLB_LANGUAGE_CODES and target in NLLB_LANGUAGE_CODES:
            return "nllb", NLLB_MODELS.get(selected_model, NLLB_MODELS["nllb_600m"])

        raise RuntimeError(
            f"Offline translation is unavailable for {source} -> {target}. "
            "This build supports Marian, NLLB, and Azure Translator."
        )

    def _validate_azure_config(self, azure_config: dict | None) -> dict:
        config = azure_config or {}
        key1 = str(config.get("key1") or "").strip()
        key2 = str(config.get("key2") or "").strip()
        region = str(config.get("region") or "").strip()
        endpoint = str(config.get("endpoint") or "https://api.cognitive.microsofttranslator.com").strip().rstrip("/")
        if not key1 and not key2:
            raise RuntimeError("Azure Translator is selected but no Azure API key is configured.")
        if not region:
            raise RuntimeError("Azure Translator is selected but region is missing.")
        return {
            "key1": key1,
            "key2": key2,
            "region": region,
            "endpoint": endpoint or "https://api.cognitive.microsofttranslator.com",
        }

    def _translate_azure(self, text: str, source: str, target: str, azure_config: dict | None) -> str:
        config = self._validate_azure_config(azure_config)
        url = build_azure_translate_url(config["endpoint"], source, target)
        body = json.dumps([{"text": text}], ensure_ascii=False).encode("utf-8")

        def call_with_key(subscription_key: str) -> str:
            headers = {
                "Content-Type": "application/json; charset=utf-8",
                "Ocp-Apim-Subscription-Key": subscription_key,
                "Ocp-Apim-Subscription-Region": config["region"],
                "X-ClientTraceId": str(uuid.uuid4()),
            }
            request = urllib_request.Request(url, data=body, headers=headers, method="POST")
            with urllib_request.urlopen(request, timeout=6) as response:
                payload = json.loads(response.read().decode("utf-8"))
            translated = payload[0]["translations"][0]["text"]
            return str(translated or "").strip()

        errors = []
        for key in [config["key1"], config["key2"]]:
            if not key:
                continue
            try:
                return call_with_key(key)
            except urllib_error.HTTPError as exc:
                try:
                    details = exc.read().decode("utf-8", errors="replace")
                except Exception:
                    details = str(exc)
                errors.append(f"HTTP {exc.code}: {details}")
            except urllib_error.URLError as exc:
                errors.append(str(exc))
            except Exception as exc:
                errors.append(str(exc))

        detail = errors[0] if errors else "Unknown Azure Translator error"
        raise RuntimeError(f"Azure Translator request failed: {detail}")

    def _ensure_marian(self, source: str, target: str) -> Callable[[str], str]:
        key = (source, target)
        backend = self.marian_cache.get(key)
        if backend is None:
            try:
                from transformers import MarianMTModel, MarianTokenizer
            except ImportError as exc:
                raise RuntimeError(
                    "Marian local translator dependencies are missing. Run Faster-Whisper Realtime setup again."
                ) from exc

            self.runtime.torch()
            backend = HFPipelineBackend(
                runtime=self.runtime,
                model_name=MARIAN_MODELS[key],
                tokenizer_loader=MarianTokenizer.from_pretrained,
                model_loader=MarianMTModel.from_pretrained,
            )
            self.marian_cache[key] = backend

        return lambda text: backend.translate(text, tokenizer_kwargs={"padding": True})

    def _ensure_nllb(self, model_name: str, source: str, target: str) -> Callable[[str], str]:
        backend = self.nllb_cache.get(model_name)
        if backend is None:
            source_code = NLLB_LANGUAGE_CODES.get(source)
            target_code = NLLB_LANGUAGE_CODES.get(target)
            if not source_code or not target_code:
                raise RuntimeError(f"{model_name} is unavailable for {source} -> {target}.")

            try:
                from transformers import AutoModelForSeq2SeqLM, AutoTokenizer
            except ImportError as exc:
                raise RuntimeError(
                    "NLLB local translator dependencies are missing. Run Faster-Whisper Realtime setup again."
                ) from exc

            self.runtime.torch()
            backend = HFPipelineBackend(
                runtime=self.runtime,
                model_name=model_name,
                tokenizer_loader=AutoTokenizer.from_pretrained,
                model_loader=AutoModelForSeq2SeqLM.from_pretrained,
            )
            self.nllb_cache[model_name] = backend

        source_code = NLLB_LANGUAGE_CODES[source]
        target_code = NLLB_LANGUAGE_CODES[target]

        def translate_text(text: str) -> str:
            if hasattr(backend.tokenizer, "src_lang"):
                backend.tokenizer.src_lang = source_code
            target_token_id = (
                backend.tokenizer.lang_code_to_id[target_code]
                if hasattr(backend.tokenizer, "lang_code_to_id")
                else backend.tokenizer.convert_tokens_to_ids(target_code)
            )
            return backend.translate(
                text,
                generation_overrides={"forced_bos_token_id": target_token_id},
            )

        return translate_text


def handle_prepare(translator: TextTranslator, payload: dict):
    engine, model_name = translator.prepare(
        payload.get("source_lang", ""),
        payload.get("target_lang", ""),
        payload.get("translation_model", "marian"),
        {
            "key1": payload.get("azure_key1", ""),
            "key2": payload.get("azure_key2", ""),
            "region": payload.get("azure_region", ""),
            "endpoint": payload.get("azure_endpoint", ""),
        },
    )
    emit({"type": "prepared", "engine": engine, "model": model_name})


def handle_translate(translator: TextTranslator, payload: dict):
    response = translator.translate(
        payload.get("text", ""),
        payload.get("source_lang", ""),
        payload.get("target_lang", ""),
        payload.get("translation_model", "marian"),
        {
            "key1": payload.get("azure_key1", ""),
            "key2": payload.get("azure_key2", ""),
            "region": payload.get("azure_region", ""),
            "endpoint": payload.get("azure_endpoint", ""),
        },
    )
    emit({
        "type": "result",
        "translated": response["translated"],
        "engine": response["engine"],
        "model": response["model"],
        "normalized_text": response["normalized_text"],
        "normalization_applied": response["normalization_applied"],
    })


def main():
    translator = TextTranslator()
    emit({"type": "ready"})

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue

        try:
            payload = json.loads(line)
            if payload.get("prepare"):
                handle_prepare(translator, payload)
            else:
                handle_translate(translator, payload)
        except Exception as exc:
            emit({"type": "error", "message": str(exc)})


if __name__ == "__main__":
    main()
