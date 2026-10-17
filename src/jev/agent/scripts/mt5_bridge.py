#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""JevTrader - MetaTrader 5 stdio koprusu.

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


def iattr(obj, name, default=0):
    """int(getattr(...)) — 0 degerini 'or' ile kaybetmeden (deal entry/type gibi)."""
    try:
        v = getattr(obj, name, default)
        if v is None:
            return default
        return int(v)
    except Exception:
        return default


TERMINAL_PATH = ""
INIT_TRIED = False
ALLOW_LAUNCH = True


def try_connect():
    """(ok, error) — terminal zaten acikse baglanir, degilse ve ALLOW_LAUNCH
    kapaliysa terminali BASLATMAZ (arka planda istemeden MT5 acilmaz)."""
    if mt5 is None:
        return False, "MetaTrader5 python paketi kurulu degil (pip install MetaTrader5)"
    try:
        if mt5.terminal_info() is not None:
            return True, ""
    except Exception:
        pass
    if not ALLOW_LAUNCH:
        return False, "MT5 terminali kapali (terminali elle ac)"
    try:
        if TERMINAL_PATH:
            ok = bool(mt5.initialize(path=TERMINAL_PATH))
        else:
            ok = bool(mt5.initialize())
    except Exception as e:
        return False, str(e)
    if ok:
        return True, ""
    try:
        return False, str(mt5.last_error())
    except Exception:
        return False, "MT5 terminaline baglanilamadi"


def ensure_init():
    global INIT_TRIED
    if mt5 is None:
        return False
    try:
        if mt5.terminal_info() is not None:
            return True
    except Exception:
        pass
    if not ALLOW_LAUNCH:
        return False
    INIT_TRIED = True
    if TERMINAL_PATH:
        return bool(mt5.initialize(path=TERMINAL_PATH))
    return bool(mt5.initialize())


def need():
    if mt5 is None:
        raise RuntimeError("MetaTrader5 python paketi kurulu degil (pip install MetaTrader5)")
    if not ensure_init():
        if not ALLOW_LAUNCH:
            raise RuntimeError("MT5 terminali kapali")
        last = ""
        try:
            last = str(mt5.last_error())
        except Exception:
            pass
        raise RuntimeError("MT5 terminaline baglanilamadi (terminal acik mi?) " + last)


# ---------------- sembol cozumleme ----------------

_SYM_CACHE = {}


def resolve_symbol(raw):
    """Istenen sembolu MT5'teki gercek yazimiyla eslestirir.
    MT5 sembol adlari buyuk/kucuk harfe DUYARLIDIR (GOLDgr != GOLDGR):
    once birebir, sonra buyuk harfli, en son tum listeyi harf duyarsiz tarayip
    gercek adi bulur. Bulunamazsa '' doner."""
    s = str(raw or "").strip()
    if not s:
        return ""
    try:
        info = mt5.symbol_info(s)
    except Exception:
        info = None
    if info is not None:
        return getattr(info, "name", "") or s
    up = s.upper()
    if up != s:
        try:
            info = mt5.symbol_info(up)
        except Exception:
            info = None
        if info is not None:
            return getattr(info, "name", "") or up
    key = s.lower()
    hit = _SYM_CACHE.get(key)
    if hit:
        return hit
    try:
        rows = mt5.symbols_get() or []
    except Exception:
        rows = []
    found = ""
    for r in rows:
        if (getattr(r, "name", "") or "").lower() == key:
            found = r.name
            break
    if found:
        _SYM_CACHE[key] = found
    return found


# ---------------- yontemler ----------------

def h_ping(p):
    return {"pong": True, "mt5": mt5 is not None, "connected": bool(ensure_init()) if mt5 else False, "launch": ALLOW_LAUNCH}


def h_policy(p):
    global ALLOW_LAUNCH
    ALLOW_LAUNCH = p.get("launch") is not False
    return {"launch": ALLOW_LAUNCH}


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
        raw = str(s).strip()
        if not raw:
            continue
        s = resolve_symbol(raw)
        if not s:
            res.append({"symbol": raw, "missing": True})
            continue
        info = mt5.symbol_info(s)
        if info is None:
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


def h_all_symbols(p):
    need()
    flt = str(p.get("filter") or "").strip()
    if flt:
        rows = mt5.symbols_get(group="*" + flt + "*") or []
    else:
        rows = mt5.symbols_get() or []
    # yalniz gorunen (Market Watch) semboller: hafif ve hizli yanit
    if p.get("visible_only"):
        rows = [r for r in rows if bool(getattr(r, "visible", False))]
    cap = 8000
    out_rows = []
    for r in rows[:cap]:
        out_rows.append({
            "name": getattr(r, "name", "") or "",
            "desc": getattr(r, "description", "") or "",
            "visible": bool(getattr(r, "visible", False)),
        })
    return {"symbols": out_rows, "count": len(rows), "truncated": len(rows) > cap}


def h_rates(p):
    """OHLC mumlar: symbol + timeframe (M1..MN1) + count (1..1000)."""
    need()
    raw_symbol = str(p.get("symbol") or "").strip()
    if not raw_symbol:
        raise RuntimeError("symbol zorunlu")
    symbol = resolve_symbol(raw_symbol)
    if not symbol:
        raise RuntimeError("sembol bulunamadi: %s (MT5'teki yazimi farkli olabilir)" % raw_symbol)
    tf_name = str(p.get("timeframe") or "M15").strip().upper()
    tf_map = {
        "M1": mt5.TIMEFRAME_M1, "M2": mt5.TIMEFRAME_M2, "M3": mt5.TIMEFRAME_M3,
        "M4": mt5.TIMEFRAME_M4, "M5": mt5.TIMEFRAME_M5, "M6": mt5.TIMEFRAME_M6,
        "M10": mt5.TIMEFRAME_M10, "M12": mt5.TIMEFRAME_M12, "M15": mt5.TIMEFRAME_M15,
        "M20": mt5.TIMEFRAME_M20, "M30": mt5.TIMEFRAME_M30,
        "H1": mt5.TIMEFRAME_H1, "H2": mt5.TIMEFRAME_H2, "H3": mt5.TIMEFRAME_H3,
        "H4": mt5.TIMEFRAME_H4, "H6": mt5.TIMEFRAME_H6, "H8": mt5.TIMEFRAME_H8,
        "H12": mt5.TIMEFRAME_H12,
        "D1": mt5.TIMEFRAME_D1, "W1": mt5.TIMEFRAME_W1, "MN1": mt5.TIMEFRAME_MN1,
    }
    if tf_name not in tf_map:
        raise RuntimeError("timeframe: " + "|".join(tf_map.keys()))
    try:
        count = int(p.get("count") or 200)
    except Exception:
        count = 200
    count = max(1, min(count, 1000))
    mt5.symbol_select(symbol, True)
    # gecmis sayfalama: before_ts verilirse o tarihten ONCEKI mumlar gelir
    try:
        before = float(p.get("before_ts") or 0)
    except Exception:
        before = 0.0
    if before > 0:
        import datetime as _dt
        tf_sec = {
            "M1": 60, "M2": 120, "M3": 180, "M4": 240, "M5": 300, "M6": 360,
            "M10": 600, "M12": 720, "M15": 900, "M20": 1200, "M30": 1800,
            "H1": 3600, "H2": 7200, "H3": 10800, "H4": 14400, "H6": 21600,
            "H8": 28800, "H12": 43200, "D1": 86400, "W1": 604800, "MN1": 2592000,
        }
        step = tf_sec.get(tf_name, 900)
        to_dt = _dt.datetime.utcfromtimestamp(max(1.0, before - 1.0))
        from_dt = to_dt - _dt.timedelta(seconds=step * count * 1.5)
        rates = mt5.copy_rates_range(symbol, tf_map[tf_name], from_dt, to_dt)
        if rates is not None and len(rates) > count:
            rates = rates[-count:]
    else:
        rates = mt5.copy_rates_from_pos(symbol, tf_map[tf_name], 0, count)
    if rates is None:
        raise RuntimeError("mum verisi alinamadi: %s %s %s" % (symbol, tf_name, mt5.last_error()))
    rows = []
    for r in rates:
        rows.append({
            "time": int(r["time"]),
            "open": float(r["open"]),
            "high": float(r["high"]),
            "low": float(r["low"]),
            "close": float(r["close"]),
            "tick_volume": int(r["tick_volume"]),
            "spread": int(r["spread"]),
            "real_volume": int(r["real_volume"]),
        })
    return {"symbol": symbol, "timeframe": tf_name, "count": len(rows), "rates": rows}


def h_ticks(p):
    """Son tick'ler: symbol + count (grafik canli fiyat icin)."""
    need()
    symbol = resolve_symbol(p.get("symbol"))
    if not symbol:
        raise RuntimeError("sembol bulunamadi: %s" % str(p.get("symbol") or "").strip())
    try:
        count = int(p.get("count") or 1)
    except Exception:
        count = 1
    count = max(1, min(count, 500))
    mt5.symbol_select(symbol, True)
    tick = mt5.symbol_info_tick(symbol)
    info = mt5.symbol_info(symbol)
    # spread: MT5'in kendi degeri (puan) — Market Watch ile birebir ayni
    return {
        "tick": d(tick),
        "spread": iattr(info, "spread", 0),
        "digits": iattr(info, "digits", 0),
        "point": float(getattr(info, "point", 0) or 0),
    }


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
    return {"deals": rows[-500:], "count": len(rows)}


def h_closed(p):
    """Kapanan pozisyonlar: deal'leri position_id'ye gore gruplar (MT5 gecmis tarzi).
    from_ts verilirse o andan itibaren (or. bugunun basi), yoksa son N gun."""
    need()
    now = time.time()
    # deal zamanlari sunucu saati tabanli olabilir: ust sinir bol birakilir
    to = now + 86400.0
    try:
        frm = float(p.get("from_ts") or 0)
    except Exception:
        frm = 0.0
    if not (frm > 0):
        try:
            days = float(p.get("days") or 7)
        except Exception:
            days = 7.0
        days = max(0.01, min(days, 90.0))
        frm = now - days * 86400.0
    sym_filter = str(p.get("symbol") or "").strip().upper()
    # onceki gunlerde acilip bugun kapanan islemlerin acilis deal'ini bulmak icin
    # deal sorgusunu geriye dogru genislet (cikti yine yalniz frm sonrasi kapanislar)
    try:
        lookback = float(p.get("open_lookback_days") or 0)
    except Exception:
        lookback = 0.0
    lookback = max(0.0, min(lookback, 30.0))
    deals = mt5.history_deals_get(frm - lookback * 86400.0, to) or []
    pos = {}
    for dl in deals:
        pid = int(getattr(dl, "position_id", 0) or 0)
        if not pid:
            continue
        row = pos.get(pid)
        if row is None:
            row = pos[pid] = {
                "position_id": pid, "symbol": str(getattr(dl, "symbol", "") or ""),
                "open": None, "close": None, "closed_volume": 0.0,
                "profit": 0.0, "swap": 0.0, "commission": 0.0,
            }
        entry = iattr(dl, "entry", -1)
        typ = iattr(dl, "type", -1)
        if entry == 0 and row["open"] is None:
            row["open"] = {"time": int(dl.time), "price": float(dl.price), "type": typ, "volume": float(dl.volume)}
            row["symbol"] = str(getattr(dl, "symbol", "") or row["symbol"])
        elif entry in (1, 2, 3):  # out / inout / out_by: kapanis deal'i
            row["close"] = {"time": int(dl.time), "price": float(dl.price), "type": typ, "volume": float(dl.volume), "reason": iattr(dl, "reason", -1)}
            row["closed_volume"] += float(getattr(dl, "volume", 0) or 0)
        row["profit"] += float(getattr(dl, "profit", 0) or 0)
        row["swap"] += float(getattr(dl, "swap", 0) or 0)
        row["commission"] += float(getattr(dl, "commission", 0) or 0)
    # SL/TP: emir gecmisinden pozisyonun son emrinin seviyeleri
    sltp = {}
    try:
        for o in (mt5.history_orders_get(frm - lookback * 86400.0, to) or []):
            pid = int(getattr(o, "position_id", 0) or 0)
            if not pid:
                continue
            cur = sltp.get(pid)
            t = int(getattr(o, "time_setup", 0) or 0)
            if cur is None or t >= cur["t"]:
                sltp[pid] = {"t": t, "sl": float(getattr(o, "sl", 0) or 0), "tp": float(getattr(o, "tp", 0) or 0)}
    except Exception:
        sltp = {}
    rows = []
    for pid, row in pos.items():
        if not row["open"] or not row["close"]:
            continue
        # yalniz istenen aralikta kapananlar (lookback yalniz acilis deal'i icindi)
        if row["close"]["time"] < frm:
            continue
        if sym_filter and row["symbol"].upper() != sym_filter:
            continue
        st = sltp.get(pid) or {"sl": 0.0, "tp": 0.0}
        rows.append({
            "position_id": pid,
            "symbol": row["symbol"],
            "type": row["open"]["type"],
            "volume": row["open"]["volume"],
            "closed_volume": round(row["closed_volume"], 4),
            "open_time": row["open"]["time"],
            "open_price": row["open"]["price"],
            "sl": st["sl"],
            "tp": st["tp"],
            "close_time": row["close"]["time"],
            "close_price": row["close"]["price"],
            "reason": int(row["close"].get("reason", -1)),
            "profit": round(row["profit"], 2),
            "swap": round(row["swap"], 2),
            "commission": round(row["commission"], 2),
        })
    rows.sort(key=lambda r: r["close_time"], reverse=True)
    return {"positions": rows[:500], "count": len(rows)}


def h_order_modify(p):
    """Bekleyen emri guncelle: ticket (+price) + sl/tp."""
    need()
    ticket = int(p.get("ticket") or 0)
    if not ticket:
        raise RuntimeError("ticket zorunlu")
    rows = mt5.orders_get(ticket=ticket)
    if not rows:
        raise RuntimeError("emir bulunamadi: %s" % ticket)
    o = rows[0]
    req = {
        "action": mt5.TRADE_ACTION_MODIFY,
        "order": ticket,
        "price": float(p.get("price") or o.price_open),
        "sl": float(p.get("sl") or 0.0),
        "tp": float(p.get("tp") or 0.0),
        "type_time": mt5.ORDER_TIME_GTC,
    }
    res = mt5.order_send(req)
    if res is None:
        raise RuntimeError("order_send None dondu " + str(mt5.last_error()))
    r = d(res)
    if int(r.get("retcode") or 0) not in (10008, 10009, 10025):
        raise RuntimeError("guncelleme reddedildi retcode=%s comment=%s" % (r.get("retcode"), r.get("comment")))
    return {"result": r}


def h_order_delete(p):
    """Bekleyen emri iptal et: ticket."""
    need()
    ticket = int(p.get("ticket") or 0)
    if not ticket:
        raise RuntimeError("ticket zorunlu")
    req = {"action": mt5.TRADE_ACTION_REMOVE, "order": ticket}
    res = mt5.order_send(req)
    if res is None:
        raise RuntimeError("order_send None dondu " + str(mt5.last_error()))
    r = d(res)
    if int(r.get("retcode") or 0) not in (10008, 10009):
        raise RuntimeError("iptal reddedildi retcode=%s comment=%s" % (r.get("retcode"), r.get("comment")))
    return {"result": r}


def _send_request(req):
    res = mt5.order_send(req)
    if res is None:
        raise RuntimeError("order_send None dondu " + str(mt5.last_error()))
    r = d(res)
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
    if int(r.get("retcode") or 0) not in (10008, 10009, 10025):
        raise RuntimeError("islem reddedildi retcode=%s comment=%s" % (r.get("retcode"), r.get("comment")))
    return r


def h_market(p):
    need()
    symbol = resolve_symbol(p.get("symbol"))
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
        "magic": int(p.get("magic") or 20260921),
        "comment": str(p.get("comment") or "JevTrader")[:26],
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
        "comment": "JevTrader close",
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


def h_margin(p):
    need()
    symbol = resolve_symbol(p.get("symbol"))
    side = str(p.get("side") or "buy").lower()
    volume = float(p.get("volume") or 0)
    if not symbol or volume <= 0 or side not in ("buy", "sell"):
        raise RuntimeError("symbol/side/volume zorunlu")
    mt5.symbol_select(symbol, True)
    price = float(p.get("price") or 0)
    if price <= 0:
        tick = mt5.symbol_info_tick(symbol)
        if tick is None:
            raise RuntimeError("tick alinamadi: " + symbol)
        price = tick.ask if side == "buy" else tick.bid
    order_type = mt5.ORDER_TYPE_BUY if side == "buy" else mt5.ORDER_TYPE_SELL
    m = mt5.order_calc_margin(order_type, symbol, volume, price)
    return {"margin": (float(m) if m is not None else None), "price": price}


def h_pending(p):
    """Bekleyen emir: buy_limit/sell_limit/buy_stop/sell_stop + price + sl/tp."""
    need()
    symbol = resolve_symbol(p.get("symbol"))
    otype = str(p.get("type") or "").lower()
    volume = float(p.get("volume") or 0)
    price = float(p.get("price") or 0)
    if not symbol or volume <= 0 or price <= 0:
        raise RuntimeError("symbol/type/volume/price zorunlu")
    tmap = {
        "buy_limit": mt5.ORDER_TYPE_BUY_LIMIT,
        "sell_limit": mt5.ORDER_TYPE_SELL_LIMIT,
        "buy_stop": mt5.ORDER_TYPE_BUY_STOP,
        "sell_stop": mt5.ORDER_TYPE_SELL_STOP,
    }
    if otype not in tmap:
        raise RuntimeError("type: buy_limit|sell_limit|buy_stop|sell_stop")
    mt5.symbol_select(symbol, True)
    info = mt5.symbol_info(symbol)
    digits = int(getattr(info, "digits", 5)) if info is not None else 5
    req = {
        "action": mt5.TRADE_ACTION_PENDING,
        "symbol": symbol,
        "volume": volume,
        "type": tmap[otype],
        "price": round(price, digits),
        "deviation": int(p.get("deviation") or 20),
        "magic": int(p.get("magic") or 20260921),
        "comment": str(p.get("comment") or "JevTrader plan")[:26],
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_RETURN,
    }
    if p.get("sl"):
        req["sl"] = round(float(p.get("sl")), digits)
    if p.get("tp"):
        req["tp"] = round(float(p.get("tp")), digits)
    return {"result": _send_request(req), "type": otype, "price": req["price"]}


HANDLERS = {
    "ping": h_ping,
    "policy": h_policy,
    "account": h_account,
    "terminal": h_terminal,
    "symbols": h_symbols,
    "all_symbols": h_all_symbols,
    "rates": h_rates,
    "ticks": h_ticks,
    "positions": h_positions,
    "orders": h_orders,
    "closed": h_closed,
    "deals": h_deals,
    "market": h_market,
    "pending": h_pending,
    "order_modify": h_order_modify,
    "order_delete": h_order_delete,
    "close": h_close,
    "modify": h_modify,
    "margin": h_margin,
}


def parse_args():
    """--no-launch: terminal kapaliysa hic acma (sessiz baglanma modu)."""
    global TERMINAL_PATH, ALLOW_LAUNCH
    ap = argparse.ArgumentParser()
    ap.add_argument("--terminal", default="")
    ap.add_argument("--no-launch", action="store_true")
    args, _ = ap.parse_known_args()
    TERMINAL_PATH = args.terminal
    if args.no_launch:
        ALLOW_LAUNCH = False


def main():
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
    parse_args()
    if mt5 is None:
        out({"event": "bridge", "connected": False, "error": "MetaTrader5 python paketi kurulu degil (pip install MetaTrader5)"})
    else:
        ok, err = try_connect()
        acc = None
        term = None
        if ok:
            acc = d(mt5.account_info())
            term = d(mt5.terminal_info())
        out({"event": "bridge", "connected": ok, "error": "" if ok else err, "account": acc, "terminal": term})
    main()
