"""Beast TTS köprüsü — eMa Lightning (canberkkkkkk/ema-lightning) sunucusu.

Kalıcı süreç: EMA modeli bir kez yüklenir (ilk seferde ağırlıklar HF'den iner),
stdin'den satır başına JSON istek okur, stdout'a 16-bit WAV (base64) yanıt yazar.
Protokol:
    -> {"id":1,"text":"Merhaba","sample_rate":48000,"speed":1.0}
    <- {"id":1,"ok":true,"wav_b64":"...","sr":48000,"dur":1.23,"ms":45}
    <- {"id":1,"ok":false,"error":"..."}
"""

import base64
import io
import json
import os
import re
import sys
import time
import wave

import numpy as np


def log(msg):
    print("[ema] " + str(msg), file=sys.stderr, flush=True)


def to_wav_b64(pcm, sr):
    pcm = np.asarray(pcm, dtype=np.float32)
    data = (np.clip(pcm, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
    buf = io.BytesIO()
    w = wave.open(buf, "wb")
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(int(sr))
    w.writeframes(data)
    w.close()
    return base64.b64encode(buf.getvalue()).decode("ascii")


def clean_text(text):
    """Emoji/simge ve markdown gürültüsünü seslendirmeden önce temizle —
    model aksi hâlde 'unicode' gibi anlamsız şeyler okuyor."""
    t = re.sub(r"```[\s\S]*?```", " Kod bloğu ekranda. ", str(text))
    t = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", t)
    t = re.sub(r"https?://\S+", " ", t)
    t = re.sub(r"[\[\]]+", " ", t)
    # BMP simge blokları (oklar, teknik, geometrik, dingbat, emoji-mücevher)
    t = re.sub("[\u2190-\u21ff\u2300-\u23ff\u2460-\u24ff\u25a0-\u25ff"
               "\u2600-\u27bf\u2900-\u297f\u2b00-\u2bff\u00a9\u00ae\u2122]", " ", t)
    # astral düzlem (renkli emoji, bayrak, ten tonu) + varyasyon seçici/ZWJ/keycap
    t = re.sub("[\U00010000-\U0010ffff]", " ", t)
    t = re.sub("[\ufe00-\ufe0f\u200d\u20e3]", "", t)
    t = re.sub(r"[*_`~#>]+", " ", t)
    return re.sub(r"\s{2,}", " ", t).strip()


def split_sentences(text, max_len=700):
    if len(text) <= max_len:
        return [text]
    parts = re.split(r"(?<=[.!?…])\s+", text)
    out, cur = [], ""
    for p in parts:
        if cur and len(cur) + len(p) + 1 > max_len:
            out.append(cur)
            cur = p
        else:
            cur = (cur + " " + p).strip() if cur else p
    if cur:
        out.append(cur)
    return out


def main():
    import torch

    torch.set_num_threads(max(2, min(4, (os.cpu_count() or 4))))
    t0 = time.perf_counter()
    from ema_lightning import EMA

    tts = EMA()
    log("model hazir (%.1f sn)" % (time.perf_counter() - t0))
    print("READY", flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:
            print(json.dumps({"ok": False, "error": "json: %s" % e}), flush=True)
            continue

        rid = req.get("id")
        try:
            op = req.get("op") or "say"
            if op == "exit":
                break
            if op == "warm":
                print(json.dumps({"id": rid, "ok": True, "warm": True}), flush=True)
                continue

            text = str(req.get("text") or "").strip()
            text = clean_text(text)
            if not text:
                print(json.dumps({"id": rid, "ok": False, "error": "bos metin"}), flush=True)
                continue
            sr = int(req.get("sample_rate") or 48000)
            if sr not in (48000, 24000, 16000, 8000):
                sr = 48000
            speed = float(req.get("speed") or 1.0)
            seed = req.get("seed")
            seed = int(seed) if seed is not None else None

            t0 = time.perf_counter()
            chunks = split_sentences(text)
            speeches = tts.say(chunks, sample_rate=sr, speed=speed, seed=seed) if len(chunks) > 1 else [
                tts.say(chunks[0], sample_rate=sr, speed=speed, seed=seed)
            ]
            gap = np.zeros(int(0.25 * sr), dtype=np.float32)
            merged = []
            for i, sp in enumerate(speeches):
                if i:
                    merged.append(gap)
                merged.append(np.asarray(sp.audio, dtype=np.float32))
            pcm = np.concatenate(merged) if merged else np.zeros(0, np.float32)
            # BAŞ SONSUZU: ses aygıtı uyanma gecikmesi ilk kelimeleri yutmasın
            # ("bazen ilk kelimeleri duymuyoruz") — başa 300ms, sona 120ms sessizlik.
            # WhatsApp da ilk 100-200ms'de kırpabilir; bu dolgu ikisini de çözer.
            pcm = np.concatenate([
                np.zeros(int(0.30 * sr), dtype=np.float32),
                pcm,
                np.zeros(int(0.12 * sr), dtype=np.float32),
            ])
            dt = time.perf_counter() - t0
            print(
                json.dumps(
                    {"id": rid, "ok": True, "wav_b64": to_wav_b64(pcm, sr), "sr": sr,
                     "dur": round(len(pcm) / sr, 2), "ms": round(dt * 1000)},
                    ensure_ascii=False,
                ),
                flush=True,
            )
        except Exception as e:  # istek bazlı hata: süreç yaşamaya devam eder
            log("istek hatasi: %r" % e)
            try:
                print(json.dumps({"id": rid, "ok": False, "error": str(e)[:300]}, ensure_ascii=False), flush=True)
            except Exception:
                pass


if __name__ == "__main__":
    main()
