#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Beast Agent <-> fastbrowse köprüsü (JEV seçer, LLM okur, kod uygular).

stdin : JSON argümanlar (tool__fastbrowse_task ile aynı şema)
stdout: TEK JSON sonuç

Kimlikler args'tan GEÇMEZ: TypeSafe anahtarı ve OpenAI-uyumlu sağlayıcı
(DeepSeek / z.ai ...) %APPDATA%\\beast\\settings.json'dan okunur — model hiç
görmez. LLM istemcisi fastbrowse'un OpenAICompatibleLLM'i; response_format
json_schema'yı desteklemeyen sağlayıcılar için istek gövdesi httpx transport
katmanında json_object'e indirilir ve şema sistem mesajına eklenir.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import sys
from pathlib import Path


def _emit(obj: dict) -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _read_args() -> dict:
    try:
        raw = sys.stdin.read()
    except Exception:
        raw = ""
    try:
        obj = json.loads(raw or "{}")
        return obj if isinstance(obj, dict) else {}
    except Exception:
        return {}


def _beast_root() -> Path:
    env = os.environ.get("BEAST_ROOT")
    if env:
        return Path(env)
    return Path(os.environ.get("APPDATA") or ".") / "beast"


def _load_settings() -> dict:
    try:
        return json.loads((_beast_root() / "settings.json").read_text(encoding="utf-8"))
    except Exception:
        return {}


def _pick_provider(settings: dict, want: str, model: str):
    """Aktif modelin sağlayıcısı (modelOverride: custom:<id>::<model>) ya da
    istenen ad/kimlik; yoksa ilk özel sağlayıcı. Anahtar yalnız burada çözülür."""
    provs = settings.get("customProviders")
    if not isinstance(provs, list):
        provs = []
    want = str(want or "").strip().lower()
    mo = str(settings.get("modelOverride") or "")
    m = re.match(r"custom:([^:]+)::(.+)$", mo)
    mo_id = m.group(1) if m else ""
    mo_model = m.group(2) if m else ""
    chosen = None
    if want:
        for p in provs:
            if not isinstance(p, dict):
                continue
            if want in (str(p.get("id") or "").lower(), str(p.get("name") or "").lower()):
                chosen = p
                break
    if chosen is None and mo_id:
        for p in provs:
            if isinstance(p, dict) and str(p.get("id") or "") == mo_id:
                chosen = p
                break
    if chosen is None and provs and isinstance(provs[0], dict):
        chosen = provs[0]
    if not chosen:
        return None
    base = str(chosen.get("baseUrl") or "").strip()
    key = str(chosen.get("key") or "").strip()
    mdl = str(model or "").strip()
    if not mdl:
        if mo_model and str(chosen.get("id") or "") == mo_id:
            mdl = mo_model
        else:
            models = chosen.get("models")
            if isinstance(models, list) and models:
                mdl = str(models[0])
    if not (base and key and mdl):
        return None
    return {
        "name": str(chosen.get("name") or chosen.get("id") or "?"),
        "baseUrl": base,
        "apiKey": key,
        "model": mdl,
    }


def _make_http():
    """httpx istemcisi: görsel soyma + json_schema indirgemesi (taşıma katmanı)."""
    import httpx

    class _SchemaDowngrade(httpx.AsyncBaseTransport):
        def __init__(self, inner):
            self._inner = inner

        async def aclose(self):
            await self._inner.aclose()

        async def handle_async_request(self, request):
            payload = None
            is_llm = False
            try:
                if request.content and b"messages" in request.content:
                    body = json.loads(request.content.decode("utf-8"))
                    changed = False
                    msgs = body.get("messages")
                    if isinstance(msgs, list):
                        # 1) GÖRSEL SOYMA: sağlayıcı (GLM/DeepSeek) görsel kabul etmiyorsa
                        #    image_url parçaları düşer, metin korunur ve kısa bir not eklenir.
                        for m in msgs:
                            if not isinstance(m, dict):
                                continue
                            c = m.get("content")
                            if isinstance(c, list):
                                texts = [
                                    str(p.get("text") or "")
                                    for p in c
                                    if isinstance(p, dict) and p.get("type") == "text"
                                ]
                                had_image = any(
                                    isinstance(p, dict) and p.get("type") == "image_url" for p in c
                                )
                                joined = "\n".join(t for t in texts if t)
                                if had_image:
                                    joined += "\n[ekran görüntüsü bu sağlayıcıya gönderilemedi — metinle devam et]"
                                m["content"] = joined
                                changed = True
                        # 2) JSON ŞEMA İNDİRGEMESİ: json_schema → json_object + şema sistem mesajı
                        rf = body.get("response_format")
                        if isinstance(rf, dict) and rf.get("type") == "json_schema":
                            schema = (rf.get("json_schema") or {}).get("schema")
                            body["response_format"] = {"type": "json_object"}
                            msgs.insert(
                                0,
                                {
                                    "role": "system",
                                    "content": "Yalnızca tek bir JSON nesnesi döndür; JSON dışında hiçbir metin yazma. Şu JSON Schema'ya uy: "
                                    + json.dumps(schema, ensure_ascii=False),
                                },
                            )
                            changed = True
                        if changed:
                            body["messages"] = msgs
                            payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
                        else:
                            payload = request.content
                        is_llm = True
            except Exception:
                pass
            req = request
            if payload is not None:
                headers = [(k, v) for (k, v) in request.headers.raw if k.lower() != b"content-length"]
                req = httpx.Request(
                    request.method,
                    request.url,
                    headers=headers,
                    content=payload,
                    extensions=request.extensions,
                )
            # NOT: 429/5xx yeniden deneme fastbrowse'un post_with_retry katmanında zaten var
            # (Retry-After'a saygılı) — burada TEKRAR denenmez, yoksa girişimler çoğalır.
            return await self._inner.handle_async_request(req)

    return httpx.AsyncClient(timeout=60, transport=_SchemaDowngrade(httpx.AsyncHTTPTransport()))


async def _resolve_cdp(client, args: dict) -> str:
    """Beast dahili Chromium CDP: DevToolsActivePort dosyası → /json/version → ws URL."""
    url = str(args.get("cdp_url") or "").strip()
    if url.startswith(("ws://", "wss://")):
        return url
    port = 0
    try:
        port = int(str(args.get("cdp_port") or "0") or 0)
    except Exception:
        port = 0
    if not port:
        appdata = Path(os.environ.get("APPDATA") or ".")
        for name in ("Beast Agent", "beast-agent", "beast"):
            f = appdata / name / "DevToolsActivePort"
            try:
                if f.exists():
                    port = int(f.read_text(encoding="utf-8").splitlines()[0].strip())
                    break
            except Exception:
                continue
    if not port:
        raise RuntimeError("DevToolsActivePort bulunamadı (Beast açık mı?)")
    r = await client.get("http://127.0.0.1:%d/json/version" % port)
    r.raise_for_status()
    ws = (r.json() or {}).get("webSocketDebuggerUrl")
    if not ws:
        raise RuntimeError("CDP webSocketDebuggerUrl yok (port %d)" % port)
    return str(ws)


_HINTS = {
    "needs_confirmation": "Geri alınamaz aksiyonda durdu (gönder/öde/sil). Kullanıcıdan onay al; uygunsa authorize:true ile tekrar çağır.",
    "needs_login": "Giriş duvarı var; kayıtlı kimlik çözülemedi. Kullanıcıdan giriş bilgisi/profil iste.",
    "needs_input": "Form alanı için değer verilmedi (model uydurmaz). Kullanıcıdan değeri al.",
    "blocked": "Bot kontrolü (CAPTCHA) geçilemedi; kullanıcının çözmesi gerekebilir.",
    "stuck": "İlerleme olmadan takıldı; görevi/dilimi netleştirip tekrar dene.",
    "budget_exceeded": "Adım/süre limiti doldu; max_steps/max_seconds artır ya da görevi böl.",
    "observation_limit": "Sayfa Jev'in girdi limitini aştı; daha dar bir görev/hedef ver.",
    "unverified": "Bitti sanıyor ama tüm iddialar kanıtlanamadı — answer'a temkinli yaklaş, sonucu doğrula.",
    "error": "Çalıştırma hatası; error alanına bak.",
}


def _result_dict(res, provider: dict, browser: str) -> dict:
    try:
        cost = {"known_dollars": round(float(res.cost.known_dollars), 4), "unknown": bool(res.cost.has_unknown)}
    except Exception:
        cost = None
    steps = []
    try:
        for s in list(res.steps)[-30:]:
            steps.append(
                {
                    "i": s.index,
                    "op": getattr(s.operation, "value", str(s.operation)),
                    "karar": getattr(s.decided_by, "value", ""),
                    "sonuc": getattr(s.outcome, "value", ""),
                    "hedef": s.target,
                    "url": s.url,
                }
            )
    except Exception:
        pass
    evidence = []
    try:
        for e in list(res.evidence)[:10]:
            quote = " ".join(str(e.quote or "").split())
            evidence.append({"quote": quote[:400], "url": e.url})
    except Exception:
        pass
    status = getattr(res.status, "value", str(res.status))
    return {
        "ok": status == "complete",
        "status": status,
        "answer": res.answer,
        "final_url": res.final_url,
        "evidence": evidence,
        "steps": steps,
        "cost": cost,
        "browser": browser,
        "provider": provider["name"] + ":" + provider["model"],
        "error": res.error,
        "hint": _HINTS.get(status, ""),
    }


async def _run(args: dict) -> dict:
    from fastbrowse import run_task
    from fastbrowse.clients.openai_compatible import OpenAICompatibleLLM
    from fastbrowse.clients.typesafe import TYPESAFE_URL, TypeSafeJevClient
    from fastbrowse.jev import JEV_MODEL
    from fastbrowse.models import Authorization, Limits, LLMPurpose, LocalChrome

    settings = _load_settings()
    ts = settings.get("typesafe") if isinstance(settings.get("typesafe"), dict) else {}
    ts_key = str(ts.get("apiKey") or "").strip()
    if not ts_key:
        return {
            "ok": False,
            "status": "error",
            "error": "TypeSafe (Jev) API anahtarı yok",
            "hint": "Ayarlar → TypeSafe sekmesinden anahtarı gir.",
        }
    if ts.get("enabled") is False:
        return {
            "ok": False,
            "status": "error",
            "error": "TypeSafe ayarı KAPALI",
            "hint": "Ayarlar → TypeSafe → anahtarı aç.",
        }
    provider = _pick_provider(settings, str(args.get("provider") or ""), str(args.get("model") or ""))
    if not provider:
        return {
            "ok": False,
            "status": "error",
            "error": "OpenAI-uyumlu LLM sağlayıcısı bulunamadı (customProviders boş ya da anahtarsız)",
            "hint": "Ayarlar → Provider'dan özel sağlayıcı ekle (ör. DeepSeek / z.ai) ve model seç.",
        }

    def _clamp(v, lo, hi, default):
        try:
            return max(lo, min(hi, type(default)(v)))
        except Exception:
            return default

    max_steps = _clamp(args.get("max_steps"), 5, 80, 40)
    max_seconds = _clamp(args.get("max_seconds"), 30.0, 600.0, 180.0)
    limits = Limits(max_steps=max_steps, max_seconds=max_seconds, max_llm_calls=50)
    authorization = Authorization(irreversible_actions=bool(args.get("authorize")))

    def _local_chrome():
        binary = str(args.get("chrome") or os.environ.get("FASTBROWSE_CHROME") or "").strip()
        return LocalChrome(binary=binary or None, headed=bool(args.get("headed")))

    http = _make_http()
    try:
        jev = TypeSafeJevClient(
            ts_key,
            http=http,
            base_url=TYPESAFE_URL,
            model=str(ts.get("model") or "").strip() or JEV_MODEL,
        )
        llm = OpenAICompatibleLLM(
            provider["apiKey"],
            http=http,
            base_url=provider["baseUrl"],
            models={purpose: provider["model"] for purpose in LLMPurpose},
            reasoning_effort=None,  # sağlayıcıya özel 'reasoning' alanı gönderilmez
        )
        kwargs = {"jev": jev, "llm": llm, "limits": limits, "authorization": authorization, "http": http}
        mode = str(args.get("mode") or "cdp").strip().lower()
        if mode == "chrome":
            kwargs["chrome"] = _local_chrome()
            browser = "chrome"
        else:
            try:
                kwargs["cdp_url"] = await _resolve_cdp(http, args)
                browser = "cdp (Beast dahili)"
            except Exception as e:
                kwargs["chrome"] = _local_chrome()
                browser = "chrome (cdp yok: %s)" % str(e)[:80]
        res = await run_task(
            str(args.get("task") or "").strip(),
            start=(str(args.get("start") or "").strip() or None),
            **kwargs,
        )
    finally:
        try:
            await http.aclose()
        except Exception:
            pass
    return _result_dict(res, provider, browser)


def main() -> None:
    args = _read_args()
    if not str(args.get("task") or "").strip():
        _emit({"ok": False, "status": "error", "error": "task gerekli (doğal dil hedef)"})
        return
    try:
        result = asyncio.run(_run(args))
    except ModuleNotFoundError as e:
        _emit(
            {
                "ok": False,
                "status": "error",
                "error": "fastbrowse yüklenemedi: " + str(e),
                "hint": "uv kurulu ve internet erişimi var mı? (uv run fastbrowse==0.4.2 ortamı kurar)",
            }
        )
        return
    except Exception as e:
        _emit({"ok": False, "status": "error", "error": type(e).__name__ + ": " + str(e)[:400]})
        return
    _emit(result)


if __name__ == "__main__":
    main()
