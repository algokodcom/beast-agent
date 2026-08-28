#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Beast hızlı web arama — önce ddgs kütüphanesi (kuruluysa), sonra çoklu motor PARALEL (thread).

ddgs (github.com/deedy5/ddgs) kuruluysa onu kullanır: anti-bot/CAPTCHA korumalı,
çok backend'li metasearch. Kurulu değilse DuckDuckGo HTML, Bing, Mojeek motorları
aynı anda sorgulanır (stdlib-only), sonuçlar harmanlanır + URL bazlı tekilleştirilir.

Kullanım:
  python websearch.py "sorgu"                 # 8 sonuç
  python websearch.py "sorgu" --limit 5 --json
Çıktı (--json): satır başına {"engine","title","url","snippet"}
"""
import argparse
import base64
import concurrent.futures as cf
import html as H
import json
import re
import sys
import urllib.parse
import urllib.request

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"}
TAG_RE = re.compile(r"<[^>]+>")
WS_RE = re.compile(r"\s+")
JUNK_TITLES = {"301 moved permanently", "302 moved temporarily", "just a moment...", "attention required!"}


def clean(s):
    return WS_RE.sub(" ", TAG_RE.sub("", H.unescape(s or ""))).strip()


def realurl(u):
    """Bing /ck/a redirect linklerini çözer; DDG uddg'yi çözer."""
    if "bing.com/ck/" in u:
        m = re.search(r"[?&]u=a1([^&]+)", u)
        if m:
            s = m.group(1)
            s += "=" * (-len(s) % 4)
            try:
                dec = base64.urlsafe_b64decode(s).decode("utf-8", "replace")
                if dec.startswith("http"):
                    return dec
            except Exception:
                pass
    if "uddg=" in u:
        m = re.search(r"[?&]uddg=([^&]+)", u)
        if m:
            return urllib.parse.unquote(m.group(1))
    if u.startswith("//"):
        u = "https:" + u
    return u


def good(row):
    return (
        row["title"]
        and row["url"].startswith("http")
        and "bing.com/ck/" not in row["url"]
        and row["title"].strip().lower() not in JUNK_TITLES
    )


def get(url, timeout=7):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def is_ddg_bot_page(raw):
    """DDG kapalı DEĞİL: bot koruması (CAPTCHA/anomaly) sayfası mı?"""
    low = (raw or "").lower()
    return "bots use duckduckgo" in low or "anomaly-modal" in low or "anomaly" in low and "duckduckgo" in low


def ddg(q):
    out = []
    try:
        raw = get("https://html.duckduckgo.com/html/?q=" + urllib.parse.quote(q))
    except Exception:
        raw = ""
    if is_ddg_bot_page(raw):
        print("[websearch] ddg: bot koruması (CAPTCHA) — kapalı DEĞİL, Bing/Mojeek devrede", file=sys.stderr)
        return out
    for m in re.finditer(
        r'<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>(.*?)</a>',
        raw,
        re.S,
    ):
        title = clean(m.group(2))
        row = {"engine": "ddg", "title": title, "url": realurl(m.group(1)), "snippet": ""}
        if good(row):
            out.append(row)
    for i, s in enumerate(re.findall(r'class="[^"]*result__snippet[^"]*"[^>]*>(.*?)</a>', raw, re.S)):
        if i < len(out):
            out[i]["snippet"] = clean(s)[:300]
    if out:
        return out
    # yedek: lite arayüz
    try:
        raw = get("https://lite.duckduckgo.com/lite/?q=" + urllib.parse.quote(q))
    except Exception:
        return out
    for m in re.finditer(r"<a[^>]+href=\"([^\"]+)\"[^>]*class=['\"]result-link['\"][^>]*>(.*?)</a>", raw, re.S):
        row = {"engine": "ddg", "title": clean(m.group(2)), "url": realurl(m.group(1)), "snippet": ""}
        if good(row):
            out.append(row)
    snips = [clean(x) for x in re.findall(r"class=['\"]result-snippet['\"][^>]*>(.*?)</td>", raw, re.S)]
    for i, s in enumerate(snips):
        if i < len(out):
            out[i]["snippet"] = s[:300]
    return out


def bing(q):
    out = []
    raw = get("https://www.bing.com/search?q=" + urllib.parse.quote(q) + "&setlang=tr")
    for m in re.finditer(
        r'<li class="b_algo".*?<h2[^>]*><a[^>]+href="(http[^"]+)"[^>]*>(.*?)</a></h2>(.*?)(?=<li class="b_algo"|</ol>)',
        raw,
        re.S,
    ):
        row = {"engine": "bing", "title": clean(m.group(2)), "url": realurl(m.group(1)), "snippet": clean(m.group(3))[:300]}
        if good(row):
            out.append(row)
    return out


def mojeek(q):
    out = []
    raw = get("https://www.mojeek.com/search?q=" + urllib.parse.quote(q))
    for m in re.finditer(
        r'<h2[^>]*>\s*<a[^>]+href="(http[^"]+)"[^>]*>(.*?)</a></h2>(.*?)(?=<h2|$)',
        raw,
        re.S,
    ):
        row = {"engine": "mojeek", "title": clean(m.group(2)), "url": realurl(m.group(1)), "snippet": clean(m.group(3))[:300]}
        if good(row):
            out.append(row)
    return out


ENGINES = {"ddg": ddg, "bing": bing, "mojeek": mojeek}


def ddg_api(q):
    """ddgs kütüphanesi kuruluysa onu kullan: anti-bot korumalı, çok backend'li.
    Kurulu değilse None döner (stdlib motorlara düşülür)."""
    try:
        from ddgs import DDGS
    except Exception:
        return None
    rows = []
    try:
        with DDGS() as d:
            for r in d.text(q, max_results=15):
                url = str(r.get("href") or r.get("url") or "")
                title = clean(str(r.get("title") or ""))
                if not title or not url.startswith("http"):
                    continue
                rows.append({
                    "engine": "ddgs",
                    "title": title,
                    "url": url,
                    "snippet": clean(str(r.get("body") or ""))[:300],
                })
    except Exception as e:
        print(f"[websearch] ddgs: {e}", file=sys.stderr)
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("query")
    ap.add_argument("--limit", type=int, default=8)
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    merged, seen = [], set()

    def add_rows(rows):
        for row in rows:
            key = row["url"].split("#")[0].rstrip("/")
            if not key or key in seen:
                continue
            seen.add(key)
            merged.append(row)

    api_rows = ddg_api(a.query)
    add_rows(api_rows or [])

    # ddgs yetersiz kaldıysa / kurulu değilse stdlib motorları paralele sok
    if len(merged) < a.limit:
        with cf.ThreadPoolExecutor(max_workers=len(ENGINES)) as ex:
            futs = {ex.submit(fn, a.query): name for name, fn in ENGINES.items()}
            try:
                for fut in cf.as_completed(futs, timeout=10):
                    name = futs[fut]
                    try:
                        add_rows(fut.result())
                    except Exception as e:
                        print(f"[websearch] {name}: {e}", file=sys.stderr)
            except cf.TimeoutError:
                print("[websearch] bazı motorlar zaman aşımına uğradı", file=sys.stderr)

    merged = merged[: max(1, a.limit)]
    if a.json:
        for r in merged:
            print(json.dumps(r, ensure_ascii=False))
    else:
        for i, r in enumerate(merged, 1):
            print(f"{i}. {r['title']}\n   {r['url']}\n   {r['snippet']}\n")
    src = "ddgs" if api_rows else "stdlib"
    print(f"[websearch] {len(merged)} sonuç ({src})", file=sys.stderr)


if __name__ == "__main__":
    main()
