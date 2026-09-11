//+------------------------------------------------------------------+
//| BeastFinance.mq5 — Beast Finance köprü EA'sı (v1.20)             |
//| - Heartbeat: MQL5\Files\beast_ea.json (durum + izinler + equity) |
//| - Komut köprüsü: beast_cmd.json (Beast yazar) → beast_cmd_ack.json|
//| - Entegrasyon/Screenshot: grafik üstü pano (Comment) + seviye     |
//|   çizgileri — Beast beast_note.json ile besler; görsel ajan      |
//|   computer_look ile chart screenshot'ında bu panoyu görür.       |
//+------------------------------------------------------------------+
#property copyright "Beast Agent"
#property link      "https://github.com/algokodcom/beast-agent"
#property version   "1.20"
#property description "Beast Finance köprü EA'sı — heartbeat + komut köprüsü + grafik panosu."

#include <Trade\Trade.mqh>

input string InpTag       = "BeastFinance"; // Etiket
input int    InpHeartbeat = 5;             // Kalp atışı (sn)
input bool   InpVerbose   = true;          // Grafik panosunu yaz
input long   InpMagic     = 20260910;      // Magic number

CTrade gTrade;

string BeatFile = "beast_ea.json";
string CmdFile  = "beast_cmd.json";
string AckFile  = "beast_cmd_ack.json";
string NoteFile = "beast_note.json";
string LvlPrefix = "BeastLvl_";

string gNoteText = "";
string gNoteSymbol = "";

int OnInit()
{
   gTrade.SetExpertMagicNumber(InpMagic);
   gTrade.SetTypeFillingBySymbol(_Symbol);
   EventSetTimer(MathMax(1, InpHeartbeat));
   WriteBeat("init");
   RefreshPanel();
   Print("BeastFinance EA başlatıldı: ", _Symbol, " period=", (int)Period());
   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason)
{
   EventKillTimer();
   WriteBeat("deinit");
   ClearLevels();
   Comment("");
}

void OnTimer()
{
   ReadNote();
   WriteBeat("beat");
   ProcessCommands();
   RefreshPanel();
}

void OnTick()
{
   // Fiyat bazlı ek işler ileride buraya eklenecek (sinyal/uyarı üretimi).
}

string JStr(string s)
{
   StringReplace(s, "\\", "\\\\");
   StringReplace(s, "\"", "\\\"");
   return s;
}

void WriteBeat(const string stage)
{
   int h = FileOpen(BeatFile, FILE_WRITE|FILE_TXT|FILE_UNICODE);
   if(h == INVALID_HANDLE) return;
   string js = StringFormat("{\"ok\":true,\"ea\":\"BeastFinance\",\"version\":\"1.20\",\"tag\":\"%s\",\"stage\":\"%s\",\"time\":%d,\"server_time\":\"%s\",\"symbol\":\"%s\",\"period\":%d,\"equity\":%.2f,\"balance\":%.2f,\"terminal_trade_allowed\":%s,\"mql_trade_allowed\":%s,\"positions\":%d,\"note\":\"%s\"}",
                            JStr(InpTag), stage, (int)TimeCurrent(), TimeToString(TimeCurrent(), TIME_DATE|TIME_SECONDS),
                            _Symbol, (int)Period(),
                            AccountInfoDouble(ACCOUNT_EQUITY), AccountInfoDouble(ACCOUNT_BALANCE),
                            (TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) ? "true" : "false"),
                            (MQLInfoInteger(MQL_TRADE_ALLOWED) ? "true" : "false"),
                            PositionsTotal(),
                            JStr(StringSubstr(gNoteText, 0, 120)));
   FileWriteString(h, js);
   FileClose(h);
}

/* ---------- grafik panosu (screenshot'larda görünür) ---------- */

void RefreshPanel()
{
   if(!InpVerbose)
   {
      Comment("");
      return;
   }
   string lines = "Beast Finance — BeastFinance v1.20\n";
   lines += _Symbol + " · " + EnumToString((ENUM_TIMEFRAMES)Period()) + " · " + TimeToString(TimeCurrent(), TIME_DATE|TIME_SECONDS) + "\n";
   lines += StringFormat("Equity: %.2f · Balance: %.2f · Acik pozisyon: %d\n",
                         AccountInfoDouble(ACCOUNT_EQUITY), AccountInfoDouble(ACCOUNT_BALANCE), PositionsTotal());
   lines += "AutoTrading: " + (TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) ? "ACIK" : "KAPALI");
   lines += " · EA izni: " + (MQLInfoInteger(MQL_TRADE_ALLOWED) ? "ACIK" : "KAPALI") + "\n";
   if(StringLen(gNoteText) > 0)
   {
      lines += "------ BEAST NOTU ------\n";
      lines += gNoteText;
   }
   Comment(lines);
}

/* Beast tarafından yazılan beast_note.json:
   {"symbol":"XAUUSD","text":"...","levels":[{"price":2400,"label":"Direnc"}]}
   symbol boş ya da bu grafiğin sembolüyse uygulanır. */
void ReadNote()
{
   if(!FileIsExist(NoteFile)) return;
   int h = FileOpen(NoteFile, FILE_READ|FILE_TXT|FILE_UNICODE);
   if(h == INVALID_HANDLE) return;
   string raw = "";
   while(!FileIsEnding(h)) raw += FileReadString(h);
   FileClose(h);
   if(StringLen(raw) == 0) return;

   string sym = JsonGet(raw, "symbol");
   if(StringLen(sym) > 0 && StringCompare(sym, _Symbol) != 0) return;
   gNoteSymbol = sym;
   gNoteText = JsonUnescape(JsonGet(raw, "text"));
   ApplyLevels(raw);
}

string JsonGet(const string js, const string key)
{
   string pat = "\"" + key + "\"";
   int i = StringFind(js, pat);
   if(i < 0) return "";
   i = StringFind(js, ":", i + StringLen(pat));
   if(i < 0) return "";
   i++;
   while(i < StringLen(js) && (StringGetCharacter(js, i) == ' ' || StringGetCharacter(js, i) == '\t')) i++;
   if(i >= StringLen(js)) return "";
   if(StringGetCharacter(js, i) == '"')
   {
      int j = StringFind(js, "\"", i + 1);
      if(j < 0) return "";
      return StringSubstr(js, i + 1, j - i - 1);
   }
   int e = i;
   while(e < StringLen(js) && StringGetCharacter(js, e) != ',' && StringGetCharacter(js, e) != '}') e++;
   string v = StringSubstr(js, i, e - i);
   StringTrimLeft(v);
   StringTrimRight(v);
   return v;
}

string JsonUnescape(string s)
{
   StringReplace(s, "\\n", "\n");
   StringReplace(s, "\\\"", "\"");
   StringReplace(s, "\\\\", "\\");
   return s;
}

/* levels dizisindeki her {price,label} için yatay çizgi çizer; eskileri siler */
void ApplyLevels(const string raw)
{
   int li = StringFind(raw, "\"levels\"");
   if(li < 0) return;
   int arr = StringFind(raw, "[", li);
   if(arr < 0) return;
   int end = StringFind(raw, "]", arr);
   if(end < 0) return;
   string body = StringSubstr(raw, arr + 1, end - arr - 1);

    string names[];
    ArrayResize(names, 64);   /* FIX: dizi boyutlandirilmadan atama EA'yi dusuruyordu */
    int n = 0;
    int pos = 0;
   while(pos < StringLen(body))
   {
      int p = StringFind(body, "\"price\"", pos);
      if(p < 0) break;
      int c = StringFind(body, ":", p);
      if(c < 0) break;
      int pe = c + 1;
      while(pe < StringLen(body) && StringGetCharacter(body, pe) != ',' && StringGetCharacter(body, pe) != '}') pe++;
      string priceStr = StringSubstr(body, c + 1, pe - (c + 1));
      StringTrimLeft(priceStr);
      StringTrimRight(priceStr);
      double price = StringToDouble(priceStr);
      string label = "";
      int lq = StringFind(body, "\"label\"", pe);
      int nq = StringFind(body, "\"price\"", pe);
      if(lq >= 0 && (nq < 0 || lq < nq))
      {
         int lc = StringFind(body, ":", lq);
         int q1 = StringFind(body, "\"", lc + 1);
         int q2 = q1 >= 0 ? StringFind(body, "\"", q1 + 1) : -1;
         if(q1 >= 0 && q2 > q1) label = StringSubstr(body, q1 + 1, q2 - q1 - 1);
      }
      if(price > 0)
      {
         string name = LvlPrefix + IntegerToString(n);
         names[n] = name;
         if(ObjectFind(0, name) < 0) ObjectCreate(0, name, OBJ_HLINE, 0, 0, price);
         ObjectSetDouble(0, name, OBJPROP_PRICE, price);
         ObjectSetInteger(0, name, OBJPROP_COLOR, clrDodgerBlue);
         ObjectSetInteger(0, name, OBJPROP_STYLE, STYLE_DOT);
         ObjectSetString(0, name, OBJPROP_TEXT, StringLen(label) > 0 ? label : "Beast");
         n++;
      }
      pos = pe;
   }
   /* bu turda üretilmeyen eski Beast çizgilerini sil */
   for(int i = n; i < n + 20; i++)
   {
      string old = LvlPrefix + IntegerToString(i);
      if(ObjectFind(0, old) >= 0) ObjectDelete(0, old);
   }
}

void ClearLevels()
{
   for(int i = 0; i < 40; i++)
   {
      string old = LvlPrefix + IntegerToString(i);
      if(ObjectFind(0, old) >= 0) ObjectDelete(0, old);
   }
}

/* ---------- komut köprüsü ---------- */

void WriteAck(const string id, const string cmd, const bool ok, const string err, const string result)
{
   int h = FileOpen(AckFile, FILE_WRITE|FILE_TXT|FILE_UNICODE);
   if(h == INVALID_HANDLE) return;
   string js = "{\"ok\":" + (ok ? "true" : "false") + ",\"id\":\"" + JStr(id) + "\",\"cmd\":\"" + JStr(cmd) + "\",\"at\":" + (string)(int)TimeCurrent();
   if(!ok) js += ",\"error\":\"" + JStr(err) + "\"";
   if(StringLen(result) > 0) js += ",\"result\":" + result;
   js += "}";
   FileWriteString(h, js);
   FileClose(h);
}

void ProcessCommands()
{
   if(!FileIsExist(CmdFile)) return;
   int h = FileOpen(CmdFile, FILE_READ|FILE_TXT|FILE_UNICODE);
   if(h == INVALID_HANDLE) return;
   string raw = "";
   while(!FileIsEnding(h)) raw += FileReadString(h);
   FileClose(h);
   if(StringLen(raw) == 0) return;

   string id  = JsonGet(raw, "id");
   string cmd = JsonGet(raw, "cmd");
   bool ok = true;
   string err = "";
   string result = "";
   if(cmd == "ping")
   {
      result = "{\"pong\":true}";
   }
   else if(cmd == "chart")
   {
      result = StringFormat("{\"symbol\":\"%s\",\"period\":%d,\"bid\":%.5f,\"ask\":%.5f,\"spread\":%d}",
                            _Symbol, (int)Period(),
                            SymbolInfoDouble(_Symbol, SYMBOL_BID), SymbolInfoDouble(_Symbol, SYMBOL_ASK),
                            (int)SymbolInfoInteger(_Symbol, SYMBOL_SPREAD));
   }
   else if(cmd == "status")
   {
      result = StringFormat("{\"equity\":%.2f,\"balance\":%.2f,\"positions\":%d,\"terminal_trade_allowed\":%s,\"mql_trade_allowed\":%s}",
                            AccountInfoDouble(ACCOUNT_EQUITY), AccountInfoDouble(ACCOUNT_BALANCE), PositionsTotal(),
                            (TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) ? "true" : "false"),
                            (MQLInfoInteger(MQL_TRADE_ALLOWED) ? "true" : "false"));
   }
   else if(cmd == "note")
   {
      /* gövde zaten beast_note.json'dan okunur; sadece yenileme tetikle */
      ReadNote();
      RefreshPanel();
      result = "{\"note\":true}";
   }
   else if(cmd == "shot")
   {
      /* ChartScreenShot -> MQL5\Files\<file> (png/gif/bmp). params:
         file, width, height, timeframe (M15/H1/...), symbol (bos=aktif grafik)
         Aktif grafik zaten istenen sembol+periyot ise ondan cekilir
         (Beast panosu + seviye cizgileri gorunur); degilse gecici grafik acilir. */
      string file = JsonGet(raw, "file");
      if(StringLen(file) == 0) file = "beast_shot.png";
      int w = (int)StringToInteger(JsonGet(raw, "width"));
      int hh = (int)StringToInteger(JsonGet(raw, "height"));
      if(w <= 0) w = 1600;
      if(hh <= 0) hh = 900;

      string symTxt = JsonGet(raw, "symbol");
      string tfTxt  = JsonGet(raw, "timeframe");

      long cid = ChartID();
      string symNow = ChartSymbol(cid);
      ENUM_TIMEFRAMES tfNow = (ENUM_TIMEFRAMES)ChartPeriod(cid);

      string symWant = symNow;
      if(StringLen(symTxt) > 0 && StringCompare(symTxt, symNow) != 0)
      {
         if(SymbolSelect(symTxt, true)) symWant = symTxt;
      }
      if(SymbolSelect(symWant, true) == false)
      {
         ok = false;
         err = "sembol bulunamadi: " + symWant;
      }

      ENUM_TIMEFRAMES tfWant = TfFromText(tfTxt);
      ENUM_TIMEFRAMES tfUse = (tfWant == PERIOD_CURRENT) ? tfNow : tfWant;
      bool tempChart = false;
      bool tplApplied = false;
      bool themeOk = false;
      int  bgNow = -1;

      if(ok && (symWant != symNow || tfUse != tfNow))
      {
         long newId = ChartOpen(symWant, tfUse);
         if(newId == 0)
         {
            ok = false;
            err = "gecici grafik acilamadi: " + symWant;
         }
         else
         {
            cid = newId;
            tempChart = true;
            /* temiz gorunum: BeastFinance.tpl temasi (EA blogu cikarilmis BeastShot.tpl) */
            string tpl = JsonGet(raw, "template");
            if(StringLen(tpl) == 0) tpl = "BeastShot";
            if(StringFind(tpl, ".") < 0) tpl = tpl + ".tpl";
            bool tplOk = false;
            if(StringCompare(tpl, "none.tpl") != 0)
            {
               tplOk = ChartApplyTemplate(cid, tpl);
               ChartRedraw(cid);
               Sleep(700);
            }
            /* sablon sembol/periyot degistirdiyse geri al */
            if(StringCompare(ChartSymbol(cid), symWant) != 0 || (ENUM_TIMEFRAMES)ChartPeriod(cid) != tfUse)
               ChartSetSymbolPeriod(cid, symWant, tfUse);
            /* sablon bulunamasa da gorunum ayni olsun -> acik tema renklerini zorla */
            themeOk = ApplyLightTheme(cid);
            bgNow = (int)ChartGetInteger(cid, CHART_COLOR_BACKGROUND);
            tplApplied = tplOk;
         }
      }

      if(ok)
      {
         ChartRedraw(cid);
         Sleep(1200);            /* mumlar/olcek otursun */
         ChartRedraw(cid);
         Sleep(200);
         if(!ChartScreenShot(cid, file, w, hh, ALIGN_RIGHT))
         {
            ok = false;
            err = "screenshot basarisiz, hata=" + IntegerToString(GetLastError());
         }
         else
         {
            result = StringFormat("{\"file\":\"%s\",\"width\":%d,\"height\":%d,\"symbol\":\"%s\",\"period\":%d,\"temp_chart\":%s,\"template_applied\":%s,\"theme_ok\":%s,\"bg\":%d}",
                                  JStr(file), w, hh, symWant, (int)tfUse, (tempChart ? "true" : "false"), (tplApplied ? "true" : "false"), (themeOk ? "true" : "false"), bgNow);
         }
      }
      if(tempChart) ChartClose(cid);
   }
   else
   {
      ok = false;
      err = "bilinmeyen komut: " + cmd;
   }
   WriteAck(id, cmd, ok, err, result);
   FileDelete(CmdFile);
}

/* BeastFinance.tpl acik tema renklerini grafige uygular (sablon bulunamazsa da garanti) */
bool ApplyLightTheme(const long cid)
{
   bool okAll = true;
   okAll = ChartSetInteger(cid, CHART_COLOR_BACKGROUND,  (long)16449525) && okAll;
   okAll = ChartSetInteger(cid, CHART_COLOR_FOREGROUND,  (long)0) && okAll;
   okAll = ChartSetInteger(cid, CHART_COLOR_GRID,        (long)12632256) && okAll;
   okAll = ChartSetInteger(cid, CHART_COLOR_CHART_UP,    (long)13434880) && okAll;
   okAll = ChartSetInteger(cid, CHART_COLOR_CHART_DOWN,  (long)0) && okAll;
   okAll = ChartSetInteger(cid, CHART_COLOR_CHART_LINE,  (long)0) && okAll;
   okAll = ChartSetInteger(cid, CHART_COLOR_CANDLE_BULL, (long)13434880) && okAll;
   okAll = ChartSetInteger(cid, CHART_COLOR_CANDLE_BEAR, (long)0) && okAll;
   okAll = ChartSetInteger(cid, CHART_COLOR_VOLUME,      (long)32768) && okAll;
   okAll = ChartSetInteger(cid, CHART_COLOR_BID,         (long)12632256) && okAll;
   okAll = ChartSetInteger(cid, CHART_COLOR_ASK,         (long)12632256) && okAll;
   okAll = ChartSetInteger(cid, CHART_COLOR_LAST,        (long)12632256) && okAll;
   okAll = ChartSetInteger(cid, CHART_COLOR_STOP_LEVEL,  (long)17919) && okAll;
   okAll = ChartSetInteger(cid, CHART_MODE, CHART_CANDLES) && okAll;
   okAll = ChartSetInteger(cid, CHART_SHOW_GRID, false) && okAll;
   okAll = ChartSetInteger(cid, CHART_SHOW_OHLC, true) && okAll;
   okAll = ChartSetInteger(cid, CHART_SHOW_BID_LINE, false) && okAll;
   okAll = ChartSetInteger(cid, CHART_SHOW_ASK_LINE, false) && okAll;
   okAll = ChartSetInteger(cid, CHART_SHOW_LAST_LINE, true) && okAll;
   ChartRedraw(cid);
   return okAll;
}

/* "M15"/"H1"/"15"/"60" gibi metni ENUM_TIMEFRAMES'e cevirir */
ENUM_TIMEFRAMES TfFromText(const string t)
{
   string s = t;
   StringTrimLeft(s);
   StringTrimRight(s);
   StringToUpper(s);
   if(s == "M1"  || s == "1")    return PERIOD_M1;
   if(s == "M5"  || s == "5")    return PERIOD_M5;
   if(s == "M15" || s == "15")   return PERIOD_M15;
   if(s == "M30" || s == "30")   return PERIOD_M30;
   if(s == "H1"  || s == "60")   return PERIOD_H1;
   if(s == "H4"  || s == "240")  return PERIOD_H4;
   if(s == "D1"  || s == "1440") return PERIOD_D1;
   if(s == "W1")                 return PERIOD_W1;
   if(s == "MN1")                return PERIOD_MN1;
   return PERIOD_CURRENT;
}
//+------------------------------------------------------------------+
