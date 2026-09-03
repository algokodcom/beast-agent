#!/usr/bin/env python3
# Beast stealth search - Obscura yaklasimi: Chrome TLS parmak izi taklidi.
# curl_cffi (curl-impersonate) ile html.duckduckgo.com'a gercek Chrome kimligiyle girer.
# stdout: ham DDG HTML - ayristirma JS tarafinda (tools.parseDdgResults) yapilir.
# Kullanim: stealthsearch.py "<url-encoded-sorgu>"
import sys
import urllib.parse


def main():
    if len(sys.argv) < 2:
        return
    q = urllib.parse.quote_plus(sys.argv[1])
    try:
        from curl_cffi import requests
    except ImportError:
        return  # kurulu degil - JS tarafi sessizce atlar
    try:
        r = requests.get(
            "https://html.duckduckgo.com/html/?q=" + q,
            impersonate="chrome",
            headers={"Accept-Language": "tr-TR,tr;q=0.9,en;q=0.8"},
            timeout=15,
        )
        sys.stdout.write(r.text or "")
    except Exception:
        return


main()
