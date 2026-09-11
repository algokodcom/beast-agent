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
   else
   {
      ok = false;
      err = "bilinmeyen komut: " + cmd;
   }
   WriteAck(id, cmd, ok, err, result);
   FileDelete(CmdFile);
}
//+------------------------------------------------------------------+
