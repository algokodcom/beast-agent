"""mt5_m15_m5 - SALT-OKUNUR yardimci. GOLD M15 + M5 son 12 bar + canli fiyat.
Arguman ALMAZ. Kopruye (mt5_bridge.py) DOKUNMAZ, ayri surecte calisir.
hicbir order_send / order_check / positions_close cagrisi YOKTUR.
Cikti: stdout'a TEK satir JSON, 2000 baytin altinda.
"""
import sys, json, datetime

SYM = "GOLD"
TERM = r"C:\Program Files\FxPro - MetaTrader 5\terminal64.exe"


def emit(o, code=0):
    sys.stdout.write(json.dumps(o, separators=(",", ":")))
    sys.stdout.flush()
    sys.exit(code)


try:
    import MetaTrader5 as mt5
except Exception as e:
    emit({"ok": False, "error": "modul yuklenemedi: " + type(e).__name__}, 1)

if not mt5.initialize(path=TERM):
    if not mt5.initialize():
        emit({"ok": False, "error": "mt5 initialize basarisiz"}, 1)

try:
    si = mt5.symbol_info(SYM)
    if si is None:
        emit({"ok": False, "error": "sembol yok: " + SYM}, 1)
    if not si.visible:
        mt5.symbol_select(SYM, True)

    def bars(tf_const, n=12):
        r = mt5.copy_rates_from_pos(SYM, tf_const, 0, n)
        if r is None or len(r) == 0:
            return []
        return [[int(x["time"]), round(float(x["open"]), 2), round(float(x["high"]), 2),
                 round(float(x["low"]), 2), round(float(x["close"]), 2)] for x in r]

    m15 = bars(mt5.TIMEFRAME_M15, 12)
    m5 = bars(mt5.TIMEFRAME_M5, 12)
    if not m15 and not m5:
        emit({"ok": False, "error": "bar alinamadi: " + SYM}, 1)

    tk = mt5.symbol_info_tick(SYM)
    if tk is None:
        st, bid, ask, sp = "--:--", 0, 0, 0
    else:
        bid, ask = round(float(tk.bid), 2), round(float(tk.ask), 2)
        sp = round(ask - bid, 2)
        st = datetime.datetime.fromtimestamp(int(tk.time), datetime.timezone.utc).strftime("%H:%M")

    emit({"ok": True, "server_time": st, "bid": bid, "ask": ask, "spread": sp,
          "m15": m15, "m5": m5}, 0)
finally:
    try:
        mt5.shutdown()
    except Exception:
        pass
