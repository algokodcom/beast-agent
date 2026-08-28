#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Beast haber toplayıcı — yalnızca standart kütüphane (requests yok).

Kaynaklar: NTV, CNN Türk, Habertürk, BBC Türkçe, Anadolu Ajansı.
Kullanım:
  python news.py                      # her kaynaktan 8 başlık
  python news.py --limit 3            # her kaynaktan 3 başlık
  python news.py --feed ntv           # tek kaynak (--json ile birlikte güzel)
  python news.py --json               # makine okunur JSON satırları
Çıktı formatı (satır başına): SAAT | KAYNAK | Başlık | Link
"""
import argparse
import json
import re
import ssl
import sys
import urllib.request
import xml.etree.ElementTree as ET

try:  # konsol kod sayfasından bağımsız temiz UTF-8 çıktı
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

FEEDS = {
    "ntv": "https://www.ntv.com.tr/gundem.rss",
    "cnnturk": "https://www.cnnturk.com/rss/rss.aspx?rss=1",
    "haberturk": "https://www.haberturk.com/rss",
    "bbcturkce": "https://feeds.bbci.co.uk/turkce/rss.xml",
    "aa": "https://www.aa.com.tr/tr/rss/default?cat=guncel",
}

TAG_RE = re.compile(r"<[^>]+>")
CTX = ssl.create_default_context()
UA = {"User-Agent": "Mozilla/5.0 BeastAgent news.py"}


def fetch(url, timeout=15):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout, context=CTX) as r:
        return r.read()


def strip_html(s):
    return TAG_RE.sub(" ", s or "").replace("&amp;", "&").replace("&quot;", '"').replace(
        "&#39;", "'"
    ).replace("&lt;", "<").replace("&gt;", ">").strip()


def text_of(node):
    return strip_html(node.text if node is not None and node.text else "")


def parse_feed(name, url):
    """RSS/Atom'u iki namespace'te de dener; (saat, kaynak, başlık, link) döner."""
    raw = fetch(url)
    root = ET.fromstring(raw)
    items = []
    for it in root.iter():
        tag = it.tag.rsplit("}", 1)[-1]
        if tag not in ("item", "entry"):
            continue
        title = link = date = ""
        for ch in it:
            t = ch.tag.rsplit("}", 1)[-1]
            if t == "title":
                title = text_of(ch)
            elif t == "link":
                link = (ch.get("href") or "").strip() or text_of(ch)
            elif t in ("pubDate", "published", "updated", "date"):
                date = text_of(ch)[:16]
        if title:
            items.append((date or "-", name.upper(), title[:180], link))
    return items


def main():
    ap = argparse.ArgumentParser(description="Beast RSS haber toplayıcı")
    ap.add_argument("--limit", type=int, default=8, help="kaynak başına başlık sayısı")
    ap.add_argument("--feed", default="", help="tek kaynak anahtarı (ntv,cnnturk,haberturk,bbcturkce,aa)")
    ap.add_argument("--json", action="store_true", help="JSON Lines çıktısı")
    a = ap.parse_args()

    wanted = {a.feed.strip().lower()} if a.feed else set(FEEDS)
    unknown = wanted - set(FEEDS)
    if unknown:
        print(f"[news.py] bilinmeyen kaynak: {', '.join(unknown)}", file=sys.stderr)

    rows, errors = [], []
    for name in FEEDS:
        if name not in wanted:
            continue
        try:
            rows.extend(parse_feed(name, FEEDS[name])[: max(0, a.limit)])
        except Exception as e:  # tek kaynak düşsün, diğerleri devam
            errors.append(f"{name}: {e}")

    if a.json:
        for r in rows:
            print(json.dumps({"time": r[0], "source": r[1], "title": r[2], "link": r[3]}, ensure_ascii=False))
    else:
        for r in rows:
            print(f"{r[0]} | {r[1]} | {r[2]}\n    {r[3]}")

    for e in errors:
        print(f"[news.py] hata {e}", file=sys.stderr)
    print(f"[news.py] {len(rows)} haber, {len(errors)} kaynak hatası", file=sys.stderr)


if __name__ == "__main__":
    main()
