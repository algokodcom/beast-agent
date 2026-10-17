"""Beast TTS köprüsü #2 — Ahenk Cep (ozgurguler/ahenk-cep-tr) sunucusu.

Kalıcı süreç: model bir kez yüklenir (ağırlıklar ilk kurulumda HF'den
%APPDATA%\\beast\\ahenk altına iner), stdin'den satır başına JSON istek okur,
stdout'a 16-bit WAV (base64) yanıt yazar. Protokol (eMa ile aynı):
    -> {"id":1,"op":"warm"}
    -> {"id":2,"op":"say","text":"Merhaba","speed":1.0,"pad":0.05}
    <- {"id":2,"ok":true,"wav_b64":"...","sr":48000,"dur":1.23,"ms":45}
    <- {"id":2,"ok":false,"error":"..."}
Ahenk Cep: EMA Lightning mimarisi, ~8.6M param (~34MB), CPU RTF ~0.2,
sabit 48 kHz. trnorm yazılı Türkçeyi okunuş formuna çevirir (say içinde).
Uzun metin eMa'daki gibi cümle parçalarına bölünüp tek tek okunur.
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

MODEL_DIR = sys.argv[1] if len(sys.argv) > 1 else "."
sys.path.insert(0, MODEL_DIR)  # ahenk_cep.py model klasöründen import edilir


def log(msg):
    print("[ahenk] " + str(msg), file=sys.stderr, flush=True)


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
    trnorm okunuşa çevirir ama model emojiyi yine harf harf 'unicode' gibi
    okuyabilir; eMa'dakiyle aynı temizlik uygulanır."""
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
    from ahenk_cep import AhenkCep

    student = os.path.join(MODEL_DIR, "student.pt")
    decoder = os.path.join(MODEL_DIR, "decoder.pt")
    tts = AhenkCep(student, decoder, device="cpu")
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
            speed = float(req.get("speed") or 1.0)
            speed = max(0.5, min(2.0, speed))

            t0 = time.perf_counter()
            chunks = split_sentences(text)
            pieces, sr = [], 48000
            for ch in chunks:
                audio_i, sr_i = tts.say(ch, style="neutral", speed=speed, seed=0)
                pieces.append(np.asarray(audio_i, dtype=np.float32))
                sr = int(sr_i or 48000)
            gap = np.zeros(int(0.25 * sr), dtype=np.float32)
            merged = []
            for i, sp in enumerate(pieces):
                if i:
                    merged.append(gap)
                merged.append(sp)
            pcm = np.concatenate(merged) if merged else np.zeros(0, np.float32)
            # BAŞ/SON sessizlik: aygıt uyanma gecikmesi ilk kelimeleri yutmasın —
            # başa 300ms, sona 120ms (eMa'da çift uygulama vardı; burada TEK kez).
            # PAD PARAMETRİK: sohbet (chat) kısa dolgu, WA varsayılan.
            pad_head, pad_tail = 0.30, 0.12
            pad = req.get("pad")
            if pad is not None:
                try:
                    v = max(0.0, min(0.30, float(pad)))
                    pad_head, pad_tail = v, max(0.02, v * 0.4)
                except Exception:
                    pass
            pcm = np.concatenate([
                np.zeros(int(pad_head * sr), dtype=np.float32),
                pcm,
                np.zeros(int(pad_tail * sr), dtype=np.float32),
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
