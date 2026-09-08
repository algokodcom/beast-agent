#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Beast Finance - MetaTrader 5 stdio koprusu.

Bilgisayardaki calisan MT5 terminaline MetaTrader5 python paketiyle baglanir.
Stdin'den JSON satirlari okur ({id, method, params}), her istegin yanitini
tek JSON satiri olarak stdout'a yazar ({id, ok, data|error}).
Baglanti olaylarini event satirlari ile bildirir ({event: 'bridge', ...}).

Gereksinim: pip install MetaTrader5  (yalnizca Windows + MT5 terminal kurulu)
"""
import sys
import json
import time
import argparse

try:
    import MetaTrader5 as mt5
except Exception:
    mt5 = None


def out(obj):
    try:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False, default=str) + "\n")
        sys.stdout.flush()
    except Exception:
        pass


def d(obj):
    """namedtuple/dict/list -> sade dict agaci (JSON'a hazir)."""
    if obj is None:
        return None
    if hasattr(obj, "_asdict"):
        return {k: d(v) for k, v in obj._asdict().items()}
    if isinstance(obj, dict):
        return {k: d(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [d(x) for x in obj]
    return obj


TERMINAL_PATH = ""
INIT_TRIED = False


def ensure_init():
    """Terminal baglantisi yoksa (yeniden) init dener; True/False doner."""
    global INIT_TRIED
    if mt5 is None:
        return False
    try:
        if mt5.terminal_info() is not None:
            return True
    except Exception:
        pass
    INIT_TRIED = True
    if TERMINAL_PATH:
        return bool(mt5.initialize(path=TERMINAL_PATH))
    return bool(mt5.initialize())


def need():
    if mt5 is None:
        raise RuntimeError("MetaTrader5 python paketi kurulu degil (pip install MetaTrader5)")
    if not ensure_init():
        last = ""
        try:
            last = str(mt5.last_error())
        except Exception:
            pass
        raise RuntimeError("MT5 terminaline baglanilamadi (terminal acik mi?) " + last)


# ---------------- yontemler ----------------

def h_ping(p):
    return {"pong": True, "mt5": mt5 is not None, "connected": bool(ensure_init()) if mt5 else False}


def h_account(p):
    need()
    return {"account": d(mt5.account_info())}


def h_terminal(p):
    need()
    return {"terminal": d(mt5.terminal_info())}


def h_symbols(p):
    need()
    syms = p.get("symbols") or []
    res = []
    for s in syms:
        s = str(s).strip().upper()
        if not s:
            continue
        info = mt5.symbol_info(s)
        if info is None:
            # sembol Market Watch'ta yoksa secmeyi dene
            mt5.symbol_select(s, True)
            info = mt5.symbol_info(s)
        if info is None:
            res.append({"symbol": s, "missing": True})
            continue
        tick = mt5.symbol_info_tick(s)
        row = d(info)
        row.update(d(tick) or {})
        row["symbol"] = s
        res.append(row)
    return {"symbols": res}


def h_positions(p):
    need()
    return {"positions": d(mt5.positions_get()) or []}


def h_orders(p):
    need()
    return {"orders": d(mt5.orders_get()) or []}


def h_deals(p):
    need()
    days = p.get("days")
    try:
        days = float(days)
    except Exception:
        days = 1.0
    days = max(0.01, min(days, 90.0))
    to = time.time()
    frm = to - days * 86400.0
    deals = mt5.history_deals_get(frm, to) or []
    rows = d(deals)
    # sadece pozisyon giris/cikislari: entry 0 giris 1 cikis (DEAL_ENTRY_OUT)
    return {"deals": rows[-500:], "count": len(rows)}


def _send_request(req):
    res = mt5.order_send(req)
    if res is None:
        raise RuntimeError("order_send None dondu " + str(mt5.last_error()))
    r = d(res)
    # bazi brokerlar IOC desteklemez: FOK, sonra RETURN ile birer kez tekrar dene
    if int(r.get("retcode") or 0) == 10030 and "type_filling" in req:
        for filling in (mt5.ORDER_FILLING_FOK, mt5.ORDER_FILLING_RETURN):
            if req["type_filling"] == filling:
                continue
            req2 = dict(req)
            req2["type_filling"] = filling
            res = mt5.order_send(req2)
            if res is None:
                continue
            r = d(res)
            if int(r.get("retcode") or 0) in (10008, 10009):
                break
    if int(r.get("retcode") or 0) not in (10008, 10009):  # PLACED / DONE
        raise RuntimeError("islem reddedildi retcode=%s comment=%s" % (r.get("retcode"), r.get("comment")))
    return r


def h_market(p):
    need()
    symbol = str(p.get("symbol") or "").strip().upper()
    side = str(p.get("side") or "").lower()
    volume = float(p.get("volume") or 0)
    if not symbol or side not in ("buy", "sell") or volume <= 0:
        raise RuntimeError("symbol/side/volume zorunlu")
    mt5.symbol_select(symbol, True)
    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        raise RuntimeError("tick alinamadi: " + symbol)
    price = tick.ask if side == "buy" else tick.bid
    order_type = mt5.ORDER_TYPE_BUY if side == "buy" else mt5.ORDER_TYPE_SELL
    req = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": symbol,
        "volume": volume,
        "type": order_type,
        "price": price,
        "deviation": int(p.get("deviation") or 20),
        "magic": int(p.get("magic") or 20260908),
        "comment": str(p.get("comment") or "Beast")[:26],
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }
    if p.get("sl"):
        req["sl"] = float(p.get("sl"))
    if p.get("tp"):
        req["tp"] = float(p.get("tp"))
    return {"result": _send_request(req), "price": price}


def h_close(p):
    need()
    ticket = int(p.get("ticket") or 0)
    if not ticket:
        raise RuntimeError("ticket zorunlu")
    pos = mt5.positions_get(ticket=ticket)
    if not pos:
        raise RuntimeError("pozisyon bulunamadi: %s" % ticket)
    pos = pos[0]
    volume = float(p.get("volume") or pos.volume)
    volume = min(volume, pos.volume)
    symbol = pos.symbol
    mt5.symbol_select(symbol, True)
    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        raise RuntimeError("tick alinamadi: " + symbol)
    is_buy = int(pos.type) == int(mt5.POSITION_TYPE_BUY)
    req = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": symbol,
        "volume": volume,
        "type": mt5.ORDER_TYPE_SELL if is_buy else mt5.ORDER_TYPE_BUY,
        "position": ticket,
        "price": tick.bid if is_buy else tick.ask,
        "deviation": int(p.get("deviation") or 20),
        "magic": int(pos.magic or 0),
        "comment": "Beast close",
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }
    return {"result": _send_request(req)}


def h_modify(p):
    need()
    ticket = int(p.get("ticket") or 0)
    if not ticket:
        raise RuntimeError("ticket zorunlu")
    pos = mt5.positions_get(ticket=ticket)
    if not pos:
        raise RuntimeError("pozisyon bulunamadi: %s" % ticket)
    pos = pos[0]
    req = {
        "action": mt5.TRADE_ACTION_SLTP,
        "symbol": pos.symbol,
        "position": ticket,
        "sl": float(p.get("sl") or 0.0),
        "tp": float(p.get("tp") or 0.0),
    }
    return {"result": _send_request(req)}


def h_pending(p):
    need()
    symbol = str(p.get("symbol") or "").strip().upper()
    ptype = str(p.get("type") or "").lower()
    volume = float(p.get("volume") or 0)
    price = float(p.get("price") or 0)
    if not symbol or volume <= 0 or price <= 0:
        raise RuntimeError("symbol/volume/price zorunlu")
    tmap = {
        "buy_limit": mt5.ORDER_TYPE_BUY_LIMIT,
        "sell_limit": mt5.ORDER_TYPE_SELL_LIMIT,
        "buy_stop": mt5.ORDER_TYPE_BUY_STOP,
        "sell_stop": mt5.ORDER_TYPE_SELL_STOP,
    }
    if ptype not in tmap:
        raise RuntimeError("type: buy_limit|sell_limit|buy_stop|sell_stop")
    mt5.symbol_select(symbol, True)
    req = {
        "action": mt5.TRADE_ACTION_PENDING,
        "symbol": symbol,
        "volume": volume,
        "type": tmap[ptype],
        "price": price,
        "deviation": int(p.get("deviation") or 20),
        "magic": int(p.get("magic") or 20260908),
        "comment": str(p.get("comment") or "Beast")[:26],
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }
    if p.get("sl"):
        req["sl"] = float(p.get("sl"))
    if p.get("tp"):
        req["tp"] = float(p.get("tp"))
    return {"result": _send_request(req)}


def h_cancel(p):
    need()
    ticket = int(p.get("ticket") or 0)
    if not ticket:
        raise RuntimeError("ticket zorunlu")
    req = {"action": mt5.TRADE_ACTION_REMOVE, "order": ticket}
    return {"result": _send_request(req)}


def h_all_symbols(p):
    """Terminaldeki tum semboller (sembol secici icin). filter: '*XAU*' gibi."""
    need()
    flt = str(p.get("filter") or "").strip()
    if flt:
        rows = mt5.symbols_get(group="*" + flt + "*") or []
    else:
        rows = mt5.symbols_get() or []
    cap = 8000
    out = []
    for r in rows[:cap]:
        out.append({
            "name": getattr(r, "name", "") or "",
            "desc": getattr(r, "description", "") or "",
            "visible": bool(getattr(r, "visible", False)),
        })
    return {"symbols": out, "count": len(rows), "truncated": len(rows) > cap}


HANDLERS = {
    "ping": h_ping,
    "account": h_account,
    "terminal": h_terminal,
    "symbols": h_symbols,
    "all_symbols": h_all_symbols,
    "positions": h_positions,
    "orders": h_orders,
    "deals": h_deals,
    "market": h_market,
    "close": h_close,
    "modify": h_modify,
    "pending": h_pending,
    "cancel": h_cancel,
}


def main():
    global TERMINAL_PATH
    ap = argparse.ArgumentParser()
    ap.add_argument("--terminal", default="")
    args, _ = ap.parse_known_args()
    TERMINAL_PATH = args.terminal

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:
            out({"id": None, "ok": False, "error": "bozuk json: %s" % e})
            continue
        rid = req.get("id")
        method = str(req.get("method") or "")
        params = req.get("params") or {}
        fn = HANDLERS.get(method)
        if fn is None:
            out({"id": rid, "ok": False, "error": "bilinmeyen yontem: " + method})
            continue
        try:
            data = fn(params)
            out({"id": rid, "ok": True, "data": data})
        except Exception as e:
            out({"id": rid, "ok": False, "error": str(e)})


if __name__ == "__main__":
    if mt5 is None:
        out({"event": "bridge", "connected": False, "error": "MetaTrader5 python paketi kurulu degil (pip install MetaTrader5)"})
    else:
        ok = False
        err = ""
        try:
            if TERMINAL_PATH:
                ok = bool(mt5.initialize(path=TERMINAL_PATH))
            else:
                ok = bool(mt5.initialize())
            if not ok:
                err = str(mt5.last_error())
        except Exception as e:
            err = str(e)
        acc = None
        term = None
        if ok:
            acc = d(mt5.account_info())
            term = d(mt5.terminal_info())
        out({"event": "bridge", "connected": ok, "error": "" if ok else err, "account": acc, "terminal": term})
    main()
