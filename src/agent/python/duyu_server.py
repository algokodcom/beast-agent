"""Beast STT köprüsü — Duyu-small (KaanAydinli/Duyu-small) sunucusu.

Kalıcı süreç: stdin'den satır başına bir JSON istek okur, stdout'a JSON yanıt yazar.
Model bir kez yüklenir (int8 ONNX, CPU). Protokol:
    -> {"id":1,"op":"warm"}
    -> {"id":2,"pcm_b64":"...","lang":"tr|en|mix|auto","mode":"auto|ctc","beam":5}
    <- {"id":2,"ok":true,"text":"...","ms":123}
    <- {"id":2,"ok":false,"error":"..."}
pcm_b64: 16 kHz mono float32 little-endian PCM'in base64'ü.
"""

import base64
import json
import os
import sys
import time

MODEL_DIR = sys.argv[1]
sys.path.insert(0, MODEL_DIR)

import numpy as np  # noqa: E402


def log(msg):
    print("[duyu] " + str(msg), file=sys.stderr, flush=True)


def main():
    threads = max(2, min(4, (os.cpu_count() or 4)))
    t0 = time.perf_counter()
    from duyu_small import DuyuSmall

    model = DuyuSmall(MODEL_DIR, quant="int8", threads=threads, beam=5, lang="mix")
    log("model hazir (%.1f sn, %d is parcacigi)" % (time.perf_counter() - t0, threads))
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
            op = req.get("op") or "transcribe"
            if op == "exit":
                break
            if op == "warm":
                print(json.dumps({"id": rid, "ok": True, "warm": True}), flush=True)
                continue

            raw = base64.b64decode(req.get("pcm_b64") or "")
            wav = np.frombuffer(raw, dtype="<f4")
            lang = req.get("lang") or "mix"
            if lang == "auto":
                lang = None
            mode = req.get("mode") or "auto"
            beam = int(req.get("beam") or 5)

            t0 = time.perf_counter()
            text = model.transcribe(np.asarray(wav, dtype=np.float32), mode=mode, lang=lang, beam=beam)
            dt = time.perf_counter() - t0
            print(json.dumps({"id": rid, "ok": True, "text": text, "ms": round(dt * 1000)}, ensure_ascii=False), flush=True)
        except Exception as e:  # istek bazlı hata: süreç yaşamaya devam eder
            log("istek hatasi: %r" % e)
            try:
                print(json.dumps({"id": rid, "ok": False, "error": str(e)[:300]}, ensure_ascii=False), flush=True)
            except Exception:
                pass


if __name__ == "__main__":
    main()
