/*
 * JEV Trader — Chat LLM çekirdeği (chat.js)
 * ------------------------------------------
 * Bu modül sohbet LLM'inin ÇİZİM + ALARM + KOMUT beynini renderer.js'ten ayırır.
 *
 * Görevleri:
 *  - Tüm çizim araçlarını tek katalogdan yönetmek (hline/hray/seg/rect/fibo/
 *    free/text/emoji/zigzag/channel/range/zone).
 *  - LLM yanıtındaki <<DRAW>>, <<PLAN>>, <<ALERT>>, <<CLEAR>>, <<CHART>>
 *    komutlarını güvenli biçimde uygulamak.
 *  - Her analizde mevcut AI çizimlerini/alarmlarını envanter olarak LLM'e
 *    vermek; eskimişleri temizleyip yeniden çizmesini sağlamak.
 *  - Çizimler varsayılan olarak TAM GENİŞLİKtir (boydan boya).
 *
 * Emir/pozisyon komutları (ORDER/OCO/CLOSE/SLTP/TRAIL/BE) renderer.js'teki
 * mevcut güvenlik katmanına delege edilir; bu modül onları yeniden yazmaz.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JEVChat = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';

  const VERSION = '2.0.0';
  const MAX_DRAWS = 20;
  const CMD_RE = /<<([A-Z_]+)\s+(\{[\s\S]*?\})\s*>>/g;

  /* ------------------------------------------------------------------ */
  /* temel yardımcılar                                                   */
  /* ------------------------------------------------------------------ */
  function cs() {
    try {
      if (typeof chartState !== 'undefined' && chartState) return chartState;
    } catch (e) { /* TDZ / yok */ }
    return root.chartState || {};
  }

  function fn(name) {
    return typeof root[name] === 'function' ? root[name] : null;
  }

  function run(name) {
    const f = fn(name);
    if (!f) return undefined;
    try { return f.apply(root, Array.prototype.slice.call(arguments, 1)); } catch (e) { return undefined; }
  }

  function rangeOn() {
    try {
      return typeof rangeModeOn === 'function' ? rangeModeOn() === true : false;
    } catch (e) { return false; }
  }

  function digits() {
    const d = Number(cs().digits);
    return Number.isFinite(d) ? Math.max(0, Math.min(8, Math.round(d))) : 5;
  }

  function fmtPrice(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n.toFixed(digits()) : '—';
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function cleanText(v, max) {
    return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max || 80);
  }

  function rates() {
    const r = cs().rates;
    return Array.isArray(r) ? r : [];
  }

  function lastBar() {
    const r = rates();
    return r.length ? r[r.length - 1] : null;
  }

  function barBase() {
    const r = rates();
    const n = r.length;
    if (!n) return { time: Math.floor(Date.now() / 1000), iv: 60 };
    const iv = n >= 2 ? Math.max(1, Number(r[n - 1].time) - Number(r[n - 2].time)) : 60;
    return {
      time: Number(r[n - 1].time) || Math.floor(Date.now() / 1000),
      iv: Number.isFinite(iv) && iv > 0 ? iv : 60,
    };
  }

  function toTime(t, base) {
    const v = Number(t);
    if (!Number.isFinite(v)) return base.time;
    if (Math.abs(v) > 1e9) return Math.round(v);
    return base.time + Math.round(v) * base.iv;
  }

  function priceOk(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || !(n > 0)) return 0;
    const f = fn('jevPriceOk');
    if (f) {
      const x = Number(f.call(root, n));
      if (Number.isFinite(x) && x > 0) return x;
      return 0;
    }
    const lb = lastBar();
    const last = lb ? Number(lb.close) : 0;
    if (last > 0 && (n > last * 8 || n < last * 0.125)) return 0;
    return n;
  }

  function point(o) {
    if (!o || typeof o !== 'object') return null;
    const p = priceOk(o.p != null ? o.p : o.price);
    if (!(p > 0)) return null;
    return { t: toTime(o.t, barBase()), p };
  }

  function push(dr) {
    if (!dr || typeof dr !== 'object') return false;
    const state = cs();
    if (!Array.isArray(state.drawings)) state.drawings = [];
    dr.src = 'ai';
    dr.at = Date.now();
    state.drawings.push(dr);
    return true;
  }

  function colorOf(type, d, def) {
    if (d && d.color) return String(d.color).slice(0, 24);
    const c = cs().drawColors || {};
    return c[type] || def || '#3b82f6';
  }

  function copyLabel(src, dr) {
    if (!src || !dr) return;
    if (src.label != null) dr.label = cleanText(src.label, 80);
    if (src.labelBottom != null) dr.labelBottom = cleanText(src.labelBottom, 80);
    if (src.labelColor) dr.labelColor = String(src.labelColor).slice(0, 24);
    if (src.labelSize != null) dr.labelSize = clamp(Math.round(Number(src.labelSize) || 9), 9, 60);
    if (src.labelAlign) {
      const a = String(src.labelAlign).toLowerCase();
      if (a === 'left' || a === 'center' || a === 'right') dr.labelAlign = a;
    }
    if (src.labelVAlign) {
      const a = String(src.labelVAlign).toLowerCase();
      if (a === 'top' || a === 'middle' || a === 'bottom') dr.labelVAlign = a;
    }
  }

  /* ------------------------------------------------------------------ */
  /* çizim kataloğu                                                      */
  /* ------------------------------------------------------------------ */
  const ALIAS = {
    line: 'seg', trend: 'seg', trendline: 'seg', ray: 'hray',
    horizontal: 'hline', level: 'hline', support: 'hline', resistance: 'hline',
    box: 'rect', rectangle: 'rect', zone: 'zone',
    ob: 'orderblock', order_block: 'orderblock', orderblock: 'orderblock',
    breaker: 'breaker', brk: 'breaker', breaker_block: 'breaker',
    fvg: 'fvg', imbalance: 'fvg', liquidity: 'liquidity', liq: 'liquidity', likidite: 'liquidity',
    buy: 'buy_order', demand: 'buy_order', buy_order: 'buy_order',
    sell: 'sell_order', supply: 'sell_order', sell_order: 'sell_order',
    bull_ob: 'buy_order', bear_ob: 'sell_order',
    fib: 'fibo', fibonacci: 'fibo', label: 'text', path: 'free',
    band: 'range', kanal: 'channel',
  };

  const ZONES = {
    buy_order: { color: '#22c55e', label: 'BUY ORDER' },
    sell_order: { color: '#ef4444', label: 'SELL ORDER' },
    orderblock: { color: '#3b82f6', label: 'ORDERBLOCK' },
    breaker: { color: '#a855f7', label: 'BREAKER' },
    fvg: { color: '#f59e0b', label: 'FVG' },
    liquidity: { color: '#06b6d4', label: 'LİKİDİTE' },
  };

  const CATALOG = [
    '[ÇİZİM KATALOĞU — TÜM ARAÇLAR]',
    'Kurallar: t = mum ofseti (0 son mum, -20 yirmi mum önce, +10 on mum sonra); p = gerçek fiyat.',
    'Fiyat uydurma; [GRAFİK BAĞLAMI], [YAPISAL SETUP] ve envanterdeki seviyelerle uyumlu çiz.',
    'CHART komutlarını yanıtın başına koy; tüm çizimler son seçilen grafik TF\'ine göre uygulanır.',
    'Aynı yanıtta en fazla 20 DRAW. Kalabalık yapma; her çizgi bir işlev taşımalı.',
    'Destek/direnç varsayılan olarak TAM GENİŞLİK hline; kısa çizgi için seg kullan.',
    'Araç seçimi: yatay destek/direnç=hline · ileri seviye=hray · trend=seg · bölge=zone/rect · konsolidasyon=range · fibo=fibo · swing=zigzag · kanal=channel · SMA/EMA=free · not=text/emoji.',
    '',
    '· hline (tam genişlik yatay seviye): <<DRAW {"type":"hline","p":1.1020,"label":"DİRENÇ"}>>',
    '· hray (sağa uzanan ışın): <<DRAW {"type":"hray","p":1.1000,"label":"DESTEK"}>>',
    '· seg (trend/kısa çizgi): <<DRAW {"type":"seg","from":{"t":-30,"p":1.1000},"to":{"t":0,"p":1.1020},"label":"trend"}>>',
    '· rect (bölge/kutu): <<DRAW {"type":"rect","from":{"t":-20,"p":1.1010},"to":{"t":5,"p":1.1030},"label":"DİRENÇ BÖLGESİ"}>>',
    '· fibo (düzeltme): <<DRAW {"type":"fibo","from":{"t":-40,"p":1.1000},"to":{"t":0,"p":1.1040}}>>',
    '· range (konsolidasyon bandı): <<DRAW {"type":"range","from":{"t":-20,"p":1.1010},"to":{"t":0,"p":1.1030},"pd":true,"label":"RANGE"}>>',
    '· channel (paralel kanal): <<DRAW {"type":"channel","from":{"t":-40,"p":1.1000},"to":{"t":0,"p":1.1030},"third":{"t":-10,"p":1.1010}}>>',
    '· zigzag (swing yapısı): <<DRAW {"type":"zigzag","points":[{"t":-30,"p":1.1000},{"t":-20,"p":1.1020},{"t":-10,"p":1.1010},{"t":0,"p":1.1030}]}>>',
    '· free (serbest eğri/SMA): <<DRAW {"type":"free","points":[{"t":-20,"p":1.1000},{"t":-10,"p":1.1010},{"t":0,"p":1.1020}]}>>',
    '· text (etiket): <<DRAW {"type":"text","t":-5,"p":1.1020,"text":"DİRENÇ"}>>',
    '· emoji: <<DRAW {"type":"emoji","t":-3,"p":1.1005,"text":"★"}>>',
    '· zone (SMC bölgesi): <<DRAW {"type":"zone","kind":"orderblock","from":{"t":-20,"p":1.1010},"to":{"t":0,"p":1.1030}}>>',
    '  zone kind: buy_order | sell_order | orderblock | breaker | fvg | liquidity; renk/etiket otomatik.',
    'Renk ve yazı: "color":"#22c55e", "label":"...", "labelColor":"#fff", "labelSize":10, "labelAlign":"left|center|right", "labelBottom":"..."',
    'Kısa çizgi gerekirse hline yerine seg kullan; hline her zaman boydan boya çizilir.',
  ].join('\n');

  const MAINTENANCE = [
    '[ÇİZİM VE ALARM BAKIMI — HER ANALİZDE ZORUNLU]',
    '1) [AI ÇİZİM/ALARM ENVANTERİ]ni oku; mevcut AI çizimlerini ve alarmlarını güncel yapıyla karşılaştır.',
    '2) Yapı değiştiyse, seviyeler eskidiyse veya çizimler birbiriyle çelişiyorsa önce <<CLEAR {"what":"ai"}>> gönder; ardından güncel seti AYNI yanıtta yeniden çiz.',
    '3) Yalnız birkaç seviye eskidiyse hepsini silmek zorunda değilsin; eskileri temizleyip eksikleri tamamla. Ama grafikte çelişkili eski çizgi bırakma.',
    '4) Her analiz sonunda grafik güncel yapıyı yansıtmalı: kilit destek/direnç, varsa OB/FVG/breaker/likidite, trend/kanal, sıkışmada EQ (%50), kırılımda %50 gövde.',
    '5) Alarmları da aynı şekilde değerlendir: eskimişleri temizle, kritik seviyelere güncel alarm bırak; aynı seviyeye tekrar alarm kurma.',
    '6) CLEAR komutunu DRAW/ALERT komutlarından önce yaz. (Uygulama CLEAR\'ı zaten önce işler.)',
    '7) Çizimler tam genişlik hline; kısa çizgi için seg. Her çizimde mümkünse fiyat etiketi kullan.',
    '8) H1 Range İçi modunda panelin mark:"h1range" çizimlerini silme; onlar otomatik yönetilir.',
  ].join('\n');

  /* ------------------------------------------------------------------ */
  /* çizim motoru (LLM komutları için)                                   */
  /* ------------------------------------------------------------------ */
  function draw(input) {
    if (!input || typeof input !== 'object') return false;
    let type = String(input.type || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    type = ALIAS[type] || type;

    /* SMC bölgeleri: type doğrudan kind olabilir */
    let zoneKind = '';
    if (type === 'zone') {
      zoneKind = String(input.kind || input.zone || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
      zoneKind = ALIAS[zoneKind] || zoneKind;
    } else if (ZONES[type]) {
      zoneKind = type;
      type = 'zone';
    }

    if (type === 'hline' || type === 'hray') {
      const pt = point({ t: input.t, p: input.p != null ? input.p : input.price });
      if (!pt) return false;
      const dr = { type, points: [pt], color: colorOf(type, input, type === 'hline' ? '#3b82f6' : '#0ea5e9') };
      copyLabel(input, dr);
      return push(dr);
    }

    if (type === 'seg' || type === 'rect' || type === 'fibo') {
      const a = point(input.from || input.a || { t: input.t, p: input.p });
      const b = point(input.to || input.b || { t: input.t2, p: input.p2 });
      if (!a || !b) return false;
      const dr = { type, points: [a, b], color: colorOf(type, input, type === 'rect' ? '#3b82f6' : '#eab308') };
      if (type === 'rect') dr.alpha = Number((cs().drawColors || {}).rectAlpha) || 12;
      copyLabel(input, dr);
      return push(dr);
    }

    if (type === 'range') {
      const a = point(input.from || input.a || { t: input.t, p: input.p });
      const b = point(input.to || input.b || { t: input.t2, p: input.p2 });
      if (!a || !b) return false;
      const dr = { type: 'range', points: [a, b], color: colorOf('range', input, '#ec4899') };
      copyLabel(input, dr);
      if (input.pd === true) dr.pd = true;
      return push(dr);
    }

    if (type === 'zone') {
      const a = point(input.from || input.a || { t: input.t, p: input.p });
      const b = point(input.to || input.b || { t: input.t2, p: input.p2 });
      if (!a || !b) return false;
      const st = ZONES[zoneKind] || null;
      const dr = {
        type: 'rect',
        points: [a, b],
        color: input.color ? String(input.color).slice(0, 24) : (st ? st.color : colorOf('rect', input, '#3b82f6')),
        alpha: Number((cs().drawColors || {}).rectAlpha) || 12,
        label: cleanText(input.label || (st ? st.label : (zoneKind ? zoneKind.toUpperCase() : 'ZONE')), 80),
      };
      if (input.labelColor) dr.labelColor = String(input.labelColor).slice(0, 24);
      if (input.labelSize != null) dr.labelSize = clamp(Math.round(Number(input.labelSize) || 9), 9, 60);
      if (input.labelAlign) dr.labelAlign = String(input.labelAlign).toLowerCase();
      return push(dr);
    }

    if (type === 'channel') {
      const a = point(input.from || input.a);
      const b = point(input.to || input.b);
      let c = point(input.third || input.c);
      if (!c && input.width != null && b) {
        const w = Number(input.width);
        if (Number.isFinite(w)) c = { t: b.t, p: b.p + w };
      }
      if (!a || !b || !c) return false;
      const dr = { type: 'channel', points: [a, b, c], color: colorOf('channel', input, '#0ea5e9'), alpha: 12 };
      copyLabel(input, dr);
      return push(dr);
    }

    if (type === 'free' || type === 'zigzag') {
      const pts = (Array.isArray(input.points) ? input.points : []).map(point).filter(Boolean);
      if (pts.length < 2) return false;
      const dr = {
        type,
        points: type === 'zigzag' ? pts.slice(0, 60) : pts.slice(0, 200),
        color: colorOf(type, input, type === 'zigzag' ? '#eab308' : '#0ea5e9'),
      };
      copyLabel(input, dr);
      return push(dr);
    }

    if (type === 'text' || type === 'emoji') {
      const pt = point({ t: input.t, p: input.p != null ? input.p : input.price });
      if (!pt) return false;
      const dr = { type, points: [pt], color: colorOf(type, input, type === 'text' ? '#e8e8ea' : '#f59e0b') };
      if (type === 'text') dr.text = cleanText(input.text || input.label || '', 120);
      else { dr.text = cleanText(input.text || '★', 8); dr.size = clamp(Math.round(Number(input.size) || 22), 10, 80); }
      if (input.labelColor) dr.labelColor = String(input.labelColor).slice(0, 24);
      return push(dr);
    }

    return false;
  }

  function plan(d) {
    const f = fn('jevPlan');
    if (!f) return false;
    try { return f.call(root, d) === true; } catch (e) { return false; }
  }

  function alert(d) {
    const f = fn('jevAlert');
    if (!f) return false;
    try { return f.call(root, d) === true; } catch (e) { return false; }
  }

  function clear(d) {
    const f = fn('jevClear');
    if (!f) return 0;
    try { return Number(f.call(root, d)) || 0; } catch (e) { return 0; }
  }

  async function chart(d) {
    const f = fn('applyChartCommand');
    if (!f) return false;
    const tf = d && typeof d.tf === 'string' ? d.tf.trim().toUpperCase() : '';
    const freeTf = rangeOn() && (tf === 'H1' || tf === 'M5');
    await f.call(root, d, freeTf ? { allowTf: true, tfAllow: ['H1', 'M5'] } : undefined);
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* komut ayrıştırma + uygulama                                         */
  /* ------------------------------------------------------------------ */
  function parse(text) {
    const cmds = [];
    let clean = String(text || '');
    clean = clean.replace(CMD_RE, (m, name, json) => {
      try {
        const data = JSON.parse(json);
        if (data && typeof data === 'object') cmds.push({ name: String(name).toUpperCase(), data });
      } catch (e) { /* bozuk JSON yok sayılır */ }
      return '';
    });
    return { clean: clean.trim(), cmds };
  }

  async function applyCommands(text, depth) {
    depth = Math.max(0, Number(depth) || 0);
    const parsed = parse(text);
    const cmds = parsed.cmds;
    const stat = {
      draw: 0, plan: 0, alert: 0, clear: 0, sltp: 0, look: 0,
      order: 0, oco: 0, code: 0, skill: 0, auto: 0, web: 0,
      file: 0, tool: 0, trail: 0, be: 0, close: 0,
    };
    const chartChanges = [];
    const lookShots = [];
    const codeEdits = [];
    const toolResults = [];

    /* 1) Grafik: sembol/TF önce değişsin ki çizimler doğru sembole yazılsın. */
    for (const c of cmds) {
      if (c.name !== 'CHART') continue;
      const bits = [];
      const tfAsk = c.data && typeof c.data.tf === 'string' ? c.data.tf.trim().toUpperCase() : '';
      const freeTf = !!(rangeOn() && (tfAsk === 'H1' || tfAsk === 'M5'));
      if (c.data && typeof c.data.symbol === 'string' && c.data.symbol.trim()) bits.push('sembol ' + c.data.symbol.trim().toUpperCase());
      if (tfAsk) bits.push(freeTf ? 'TF ' + tfAsk : 'TF sabit (değiştirilmedi)');
      try {
        await chart(c.data);
        if (bits.length) chartChanges.push(bits.join(' · '));
      } catch (e) { /* yok say */ }
    }

    /* 2) Temizlik: hangi sırada yazılırsa yazılsın DRAW/ALERT'ten önce çalışsın. */
    let changedDraw = false, changedPlan = false, changedAlert = false;
    for (const c of cmds) {
      if (c.name !== 'CLEAR') continue;
      const n = clear(c.data);
      if (n > 0) {
        stat.clear += n;
        changedDraw = changedPlan = changedAlert = true;
      }
    }

    /* 3) Çizim / plan / alarm ve diğer komutlar. */
    for (const c of cmds) {
      try {
        if (c.name === 'CHART' || c.name === 'CLEAR') continue;
        if (c.name === 'DRAW') {
          if (stat.draw < MAX_DRAWS && draw(c.data)) { stat.draw++; changedDraw = true; }
        } else if (c.name === 'PLAN') {
          if (plan(c.data)) { stat.plan++; changedPlan = true; }
        } else if (c.name === 'ALERT') {
          if (alert(c.data)) { stat.alert++; changedAlert = true; }
        } else if (c.name === 'SLTP') {
          stat.sltp += Number(await callAsync('jevSltp', c.data)) || 0;
        } else if (c.name === 'TRAIL') {
          stat.trail += Number(await callAsync('jevTrail', c.data)) || 0;
        } else if (c.name === 'BE') {
          stat.be += Number(await callAsync('jevBe', c.data)) || 0;
        } else if (c.name === 'CLOSE') {
          stat.close += Number(await callAsync('jevClose', c.data)) || 0;
        } else if (c.name === 'ORDER') {
          stat.order += Number(await callAsync('jevOrders', c.data)) || 0;
        } else if (c.name === 'OCO') {
          stat.oco += Number(await callAsync('jevOco', c.data)) || 0;
        } else if (c.name === 'LOOK') {
          const f = fn('jevLook');
          if (f && await f.call(root, c.data, depth, lookShots)) stat.look++;
        } else if (c.name === 'WEB') {
          const f = fn('jevWeb');
          if (f && toolResults.length < 4) {
            const r = await f.call(root, c.data);
            if (r) { toolResults.push(r); stat.web++; }
          }
        } else if (c.name === 'FILE') {
          const f = fn('jevFile');
          if (f && toolResults.length < 4) {
            const r = await f.call(root, c.data);
            if (r) { toolResults.push(r); stat.file++; }
          }
        } else if (c.name === 'TOOL') {
          if (await callAsync('jevToolCommand', c.data)) stat.tool++;
        } else if (c.name === 'SKILL') {
          if (await callAsync('jevSkillCommand', c.data)) stat.skill++;
        } else if (c.name === 'AUTO') {
          if (run('jevAutoCommand', c.data)) stat.auto++;
        } else if (c.name === 'CODE') {
          const ed = run('jevCodeEdit', c.data);
          if (ed) { codeEdits.push(ed); stat.code++; }
        }
      } catch (e) {
        run('jevLogAdd', 'KOMUT HATASI · ' + c.name + ' · ' + String((e && e.message) || e), 'err');
      }
    }

    if (changedDraw) { run('saveDrawings'); run('drawChart'); }
    if (changedPlan) { run('savePlans'); run('applyPlanButtons'); run('drawChart'); }
    if (changedAlert) { run('saveAlerts'); run('renderAlertSide'); run('drawChart'); }

    const parts = [];
    for (const ch of chartChanges) parts.push('grafik ' + ch);
    if (stat.draw) parts.push(stat.draw + ' çizim');
    if (stat.plan) parts.push(stat.plan + ' plan (grafikteki GİR ile aç)');
    if (stat.alert) parts.push(stat.alert + ' alarm');
    if (stat.sltp) parts.push(stat.sltp + ' pozisyon SL/TP güncellendi');
    if (stat.trail) parts.push(stat.trail + ' pozisyonda trailing ayarlandı');
    if (stat.be) parts.push(stat.be + ' pozisyon BE');
    if (stat.close) parts.push(stat.close + ' pozisyon kapatıldı');
    if (stat.order) parts.push(stat.order + ' işlem açıldı');
    if (stat.oco) parts.push(stat.oco + ' OCO kuruldu (biri tetiklenince diğeri iptal)');
    if (stat.look) parts.push(stat.look + ' görsel isteği (sohbete gönderildi)');
    if (stat.web) parts.push(stat.web + ' web isteği (sonuç LLM\'e geri gönderiliyor)');
    if (stat.file) parts.push(stat.file + ' dosya okuma (sonuç LLM\'e geri gönderiliyor)');
    if (stat.tool) parts.push(stat.tool + ' toolbox aracı işlemi');
    if (stat.clear) parts.push(stat.clear + ' öğe temizlendi');
    if (stat.skill) parts.push(stat.skill + ' skill işlemi');
    if (stat.auto) parts.push('ayar güncellendi (risk/analiz sıklığı)');
    if (stat.code) parts.push(stat.code + ' kod düzenleme (test edilip uygulama yeniden başlatılacak)');

    if (parts.length) {
      const head = (stat.order || stat.oco)
        ? 'Jev işlem açtı: '
        : (stat.sltp || stat.trail || stat.be || stat.close)
          ? 'Jev uyguladı: '
          : ((stat.code || stat.skill || stat.tool) && !stat.draw && !stat.plan && !stat.alert)
            ? 'Jev: '
            : 'Jev çizdi: ';
      run('toast', head + parts.join(' · '));
      run('termLogAdd', 'JEV UYGULADI · ' + parts.join(' · '), 'sys');
      run('jevLogAdd', 'UYGULADI · ' + parts.join(' · '), 'cmd');
    }

    if (lookShots.length) {
      const f = fn('jevSendLookShots');
      if (f) f.call(root, lookShots, depth).catch(function () {});
    }
    if (toolResults.length) {
      const f = fn('jevSendToolResults');
      if (f) f.call(root, toolResults, depth).catch(function () {});
    }
    if (codeEdits.length) {
      const f = fn('applyCodeEdits');
      if (f) f.call(root, codeEdits).catch(function (e) {
        run('jevLogAdd', 'KOD · hata · ' + String((e && e.message) || e), 'err');
      });
    }

    const clean = parsed.clean;
    if (!clean && parts.length) return 'Uygulandı: ' + parts.join(' · ');
    return clean;
  }

  async function callAsync(name, data) {
    const f = fn(name);
    if (!f) return 0;
    try { return await f.call(root, data); } catch (e) { return 0; }
  }

  /* ------------------------------------------------------------------ */
  /* envanter + prompt blokları                                          */
  /* ------------------------------------------------------------------ */
  function refPriceOf(d) {
    const P = d && Array.isArray(d.points) ? d.points : [];
    if (!P.length) return 0;
    if (d.type === 'hline' || d.type === 'hray' || d.type === 'text' || d.type === 'emoji') return Number(P[0].p) || 0;
    const a = Number(P[0].p);
    const b = Number(P[P.length - 1].p);
    if (Number.isFinite(a) && Number.isFinite(b)) return (a + b) / 2;
    return Number.isFinite(a) ? a : 0;
  }

  function describeDrawing(d) {
    if (!d || typeof d !== 'object') return '';
    const P = Array.isArray(d.points) ? d.points : [];
    const label = d.label ? ' "' + cleanText(d.label, 40) + '"' : '';
    const lowHigh = () => {
      const ps = P.map(function (x) { return Number(x.p); }).filter(Number.isFinite);
      if (!ps.length) return '';
      const lo = Math.min.apply(null, ps);
      const hi = Math.max.apply(null, ps);
      return fmtPrice(lo) + '–' + fmtPrice(hi);
    };
    const t = String(d.type || '').toLowerCase();
    if (t === 'hline') return 'yatay ' + fmtPrice(P[0] && P[0].p) + label;
    if (t === 'hray') return 'ışın ' + fmtPrice(P[0] && P[0].p) + label;
    if (t === 'seg' || t === 'ray' || t === 'fibo') return t + ' ' + lowHigh() + label;
    if (t === 'rect' || t === 'range' || t === 'channel') return t + ' ' + lowHigh() + label;
    if (t === 'free' || t === 'zigzag') return t + ' ' + P.length + ' nokta' + label;
    if (t === 'text') return 'metin "' + cleanText(d.text || '', 40) + '" @' + fmtPrice(P[0] && P[0].p);
    if (t === 'emoji') return 'emoji @' + fmtPrice(P[0] && P[0].p);
    return t + ' ' + lowHigh() + label;
  }

  function atrNow() {
    const S = root.JEVStructure;
    if (!S || typeof S.atr !== 'function') return 0;
    const r = rates();
    const closed = r.length > 1 ? r.slice(0, -1) : r;
    if (closed.length < 20) return 0;
    const a = Number(S.atr(closed, 14));
    return Number.isFinite(a) && a > 0 ? a : 0;
  }

  function inventoryBlock() {
    const state = cs();
    const last = lastBar();
    const lastP = last ? Number(last.close) : 0;
    const atr = atrNow();
    const drawings = (Array.isArray(state.drawings) ? state.drawings : [])
      .filter(function (d) { return d && d.src === 'ai' && d.mark !== 'h1range'; });
    const alerts = (Array.isArray(state.alerts) ? state.alerts : [])
      .filter(function (a) {
        return a && a.src === 'ai' && (!a.symbol || String(a.symbol).toUpperCase() === String(state.symbol || '').toUpperCase());
      });

    function farTag(p) {
      if (!(lastP > 0) || !(p > 0)) return '';
      if (atr > 0) return Math.abs(p - lastP) > atr * 4 ? ' [uzak]' : '';
      return Math.abs(p - lastP) / lastP > 0.005 ? ' [uzak]' : '';
    }

    const out = [];
    out.push('[AI ÇİZİM/ALARM ENVANTERİ] (analizden önce değerlendir)');
    out.push('Aktif grafik: ' + (state.symbol || '—') + ' ' + (state.tf || '—'));
    if (!drawings.length) out.push('AI çizimi: yok');
    else {
      out.push('AI çizimleri (' + drawings.length + '):');
      drawings.slice(-24).forEach(function (d) {
        const rp = refPriceOf(d);
        out.push('  · ' + describeDrawing(d) + farTag(rp));
      });
      if (drawings.length > 24) out.push('  … ve ' + (drawings.length - 24) + ' çizim daha (kalabalıksa hepsini temizleyip yeniden çiz)');
    }
    if (!alerts.length) out.push('AI alarmı: yok');
    else {
      out.push('AI alarmları (' + alerts.length + '):');
      alerts.slice(-16).forEach(function (a) {
        const cond = String(a.cond || 'cross');
        out.push('  · ' + Number(a.price) + ' ' + cond + (a.repeat ? ' · tekrarlı' : ' · tek') +
          (a.active === false ? ' [tetiklendi]' : '') +
          (a.note ? ' "' + cleanText(a.note, 50) + '"' : '') + farTag(Number(a.price)));
      });
      if (alerts.length > 16) out.push('  … ve ' + (alerts.length - 16) + ' alarm daha (eskimişleri temizle)');
    }
    out.push('Kural: Bu listeyi güncel yapıyla karşılaştır; eskimiş/çelişkili çizim ve alarmları temizleyip güncel seti yeniden çiz.');
    return out.join('\n');
  }

  function promptBlocks() {
    return CATALOG + '\n\n' + MAINTENANCE;
  }

  function systemPromptSuffix() {
    return promptBlocks();
  }

  function systemPrompt() {
    return BASE_PROMPT + '\n\n' + CATALOG + '\n\n' + MAINTENANCE;
  }

  /* ------------------------------------------------------------------ */
  /* LLM taban sistem promptu (renderer.js'ten taşındı)                 */
  /* ------------------------------------------------------------------ */
  const BASE_PROMPT = [
  'Sen "JevTrader" adlı yerel trading uygulamasının SOHBET LLM asistanısın. Uygulamada "Jev" adı ayrıca TypeSafe (jev-latest) tabanlı tipli karar motoru için kullanılır; ikisini karıştırma, sen o motor değilsin.',
  'Her mesajda sana [GRAFİK BAĞLAMI] metin bloğu ve grafiğin anlık ekran görüntüsü iletilir.',
  'Bağlam iki bloktur: (1) KAPANMIŞ MUM SERİLERİ — YALNIZ analiz için seçilen zaman dilimlerinin kapanmış mumları (hangi TF\'lerin listelendiği [ANALİZ ZAMAN DİLİMİ] ve bağlam başlığında yazar); (2) CANLI DURUM — son fiyat, GÜN ÖZETİ (gün başı bakiyesi, bugünün tüm işlemleri ve net K/Z), [PERFORMANS HAFIZASI] (kalıcı gerçekleşen istatistik ve karar kalitesi), [GÜNLÜK KORUMA], kapanmamış (canlı) mumlar, hesap özeti, açık pozisyonlar, bekleyen emirler, son kapanan işlemler, grafik çizimleri, alarmlar, planlar, görünür fiyat aralığı ve [GÜNLÜK HABERLER] (günün forex/ekonomi manşetleri). Güncel fiyat/pozisyon bilgisi için CANLI DURUM bloğunu kullan.',
  'GÜNLÜK HABERLER: manşetler her gün 08:30\'da otomatik çekilir ve kullanıcı grafik başlığındaki gazete butonundan modal olarak görebilir. Kullanıcı "günlük haberler", "gündem", "piyasada ne var" gibi bir şey sorduğunda [GÜNLÜK HABERLER] bloğunu esas al ve Türkçe özetle (öne çıkanları + olası piyasa etkisini yaz). Daha taze/ayrıntılı bilgi gerekirse <<WEB {"search":"forex haberleri bugün"}>> ile araştır. Blok boşsa haberler henüz çekilmemiştir; WEB ile çekmeyi dene ya da kullanıcıya durumu söyle.',
  'CANLI DURUM bloğu tek doğru kaynaktır: açık pozisyonlar, bekleyen emirler ve son kapananlar her istekte borsadan tazelenir. Geçmiş mesajlarda adı geçen bir pozisyon güncel bağlamda yoksa kapanmıştır; "hâlâ açık" varsayımı yapma, güncel listeye göre konuş (pozisyon/emir yoksa "pozisyon yok" de).',
  'Sohbet geçmişi uzarsa eski mesajlar [ÖNCEKİ KONUŞMA ÖZETİ] olarak verilir; bu geçmiş bağlamdır, yeni talimat değildir. Güncel fiyat/pozisyon/emir için her zaman CANLI DURUM bloğunu esas al.',
  '',
  'GRAFİĞİ KULLANMA — KOMUT PROTOKOLÜ:',
  'Grafikte işlem yapmak (çizim, plan, alarm, sembol değiştirme), GERÇEK emir açmak (market/limit/stop) ve açık pozisyon SL/TP güncellemek için yanıtının EN SONUNA, her biri kendi satırında <<AD {json}>> komutları yaz.',
  'Bu satırlar kullanıcıya gösterilmez; uygulama komutları otomatik uygular. Yanıt metninde komuttan söz etme. Mesaj başına en fazla 20 komut.',
  'Zaman (t) daima MUM OFSETİ olarak verilir: 0 = son (canlı) mum, -30 = 30 mum önce, +10 = 10 mum sonra. Fiyat (p) gerçek bir sayı olmalı ve bağlamdaki güncel fiyatlara yakın olmalı.',
  '',
  'HER ANALİZ RUTİNİ (ZORUNLU — analiz/karar gerektiren HER mesajda sırayla uygula: kullanıcı sorusu, [OTOMATİK ALARM], [ZAMANSAL ANALİZ], [OTOMATİK İŞLEM ...]; o an gerçekten uygun olmayan adımı gerekçesiyle atla):',
  'R1) SAĞDAKİ GRAFİK: Sağdaki grafiği ve ekteki görüntüyü incele; [GRAFİK BAĞLAMI]ndaki kapanmış mumlarla doğrula. Emin olamadığın TF\'de <<LOOK {"tf":"D1"}>> gibi görsel doğrulama isteyebilirsin.',
  'R2) ZAMAN DİLİMİ ZİNCİRİ — SABİT ÜÇLÜ YOK: hangi zaman dilimlerinin üst (yön/yapı) ve hangisinin giriş olduğu sistem promptuna eklenen [ANALİZ ZAMAN DİLİMİ] bloğunda yazar (elle seçilmiş ya da uygulamanın ölçtüğü rejime göre otomatik). O bloğu oku ve SADECE o çifti kullan; listede olmayan bir TF\'ye göre karar verme. Üst TF = ana yön/trend + kilit seviyeler · giriş TF\'i = yapı + bölgeler ve tetik zamanlaması. Yanıtının başında iki TF\'in yönünü kısaca yaz (ör. "H1 ↑ · M5 →"); ikisini de değerlendirmeden emir/karar verme.',
  'R3) ÇİZ: Analizde anlamlı seviye/bölge/trend varsa çiz (<<DRAW>>: hline/hray/seg/rect/fibo/free/text/channel/zigzag/range; SMC bölgeleri: <<DRAW {"type":"zone","kind":"orderblock|breaker|fvg|buy_order|sell_order|liquidity",...}>>). Destek/direnç seviyelerini hline ile TAM GENİŞLİK çiz (varsayılan); kısa çizgi gerekiyorsa seg kullan. Eskimiş [AI] çizimleri <<CLEAR {"what":"ai"}>> ile temizleyip güncel seviyeleri yeniden çiz; trend/kutu çizgilerini son mumun ötesine (pozitif t) uzat. Çizilecek bir şey yoksa zorlama.',
  'R4) ALARM: Her analizde takip edilmesi gereken kritik seviyeye <<ALERT>> bırakmayı hedefle (mevcut [AI] alarmı aynı seviyedeyse yeniden kurma; seviye değiştiyse eskisini temizle). Olay/kırılım/hedef → tek seferlik · sürekli izlenecek destek/direnç ve açık pozisyonun SL/TP yakını → repeat:true.',
  'R5) TOOLBOX: İşini kolaylaştıracak mevcut aracı <<TOOL {"action":"run","name":"..."}>> ile çalıştır; tekrar eden bir ihtiyaç fark edersen <<TOOL {"action":"save",...}>> ile yeni araç yaz. Gerekmiyorsa kullanma.',
  'R6) EMİR: Geçerli setup varsa (pozitif EV; p ve SL/TP zorunlu — bkz. BEKLENEN DEĞER) <<ORDER>> ile ya da iki yönlü kırılımda <<OCO>> ile GERÇEK işlemi aç. Emir türünü analize göre seç: hemen giriş → market · retest/geri çekilme → limit · kırılım teyidi → stop. "grade" ver. Setup yoksa zorla emir açma, "işlem yok" de.',
  'R7) POZİSYON YÖNETİMİ: Açık pozisyon varsa değerlendir. ZARARDA PANİK YOK: orijinal SL ve lot girişte belirlendi; tez/setup hâlâ geçerliyse beklemeye devam et — zararda yarım kapatma, SL\'i fiyata yaklaştırma ya da SL\'i geriye genişletme YASAK. Yalnız kuruluş gerçekten geçersizleştiyse (yapı kırıldı, tez öldü) TAMAMEN kapat. KÂRDA AKSİYON ZORUNLU: kâr ~1R olunca <<BE>> ya da <<TRAIL>> ile SL\'i ilerlet, 1,5-2R civarında <<CLOSE {"pct":...}>> ile kademeli kâr al, kalanı geniş trailing ile koştur; "kârdayken hiçbir şey yapmamak" yasak. SL yalnız KÂR yönüne taşınır, riski büyüten değişiklik yasak. Kâr/R durumunu yanıtında belirt.',
  'R8) RİSK + RAPOR: GÜN ÖZETİ\'ne ve [PERFORMANS HAFIZASI] bloğuna göre riski <<AUTO {"risk":...}>> ile ayarla (seri kayıpta düşür, isabet başabaşın altındaysa RR\'i büyüt ya da o setup tipini bırak). Yanıtı 1-2 cümlede tut: seçili iki TF\'in yönü + kilit seviyeler + uyguladığın aksiyonlar (çizim/alarm/tool/emir/SLTP).',
  'R9) SWING TARZI (ZORUNLU — uygulamanın varsayılan işlem tarzıdır): Kısa vadeli/sıkı stoplu scalp işlemleri YASAK; hedef günler süren hareketlerdir.',
  '· YÖN/YAPI: H4 ve D1. Giriş: H1 (tercih) — M15 yalnız tetik teyidi, M5 ve altı karar için kullanılmaz.',
  '· SL: son belirgin swing high/low\'un ÖTESİNE + ATR tamponu. Tercihen mesafe ~1,25 × ATR14(H4) olsun; uygulama SL/TP seviyelerini değiştirmez — gönderdiğin stop aynen kullanılır.',
  '· TP: en az 2R, tercihen 2,5–4R (EV modu B: düşük isabet + büyük R); hedef H4/D1 yapı seviyesine oturmalı, yakın gürültü seviyesine değil.',
  '· SIKLIK: A/A+ swing setup yoksa hiç işlem açma; sembol başına günde en fazla 1 yeni işlem. M15/M5 gürültüsüne emir kovalamak yasak.',
  '· YÖNETİM: pozisyon saatler/günler taşınır. Kâr 1R\'ye ulaşana kadar kısmi kâr alma ve SL oynatma. İlk kısmi kâr ≥1,5–2R\'de; trailing startR ≥1, distR ≥0,75–1R ile geniş tut, kalanı trend bitene kadar koştur. Zararda tek müdahale H4/D1 yapısı gerçekten bozulursa tamamen kapatmak.',
  '· İSTİSNA — SCALP (yalnız dinamik [İŞLEM TARZI] bloğu izin veriyorsa): ara sıra kısa vadeli scalp yapabilirsin; emri "scalp":true ile işaretle. Scalp: risk ≤ %0,5 (uygulama üst sınırı zorlar) · SL ~0,35×ATR14(H4) · TP 0,8–1,5R ve hızlı kapat. Scalp, swing setup\'ını gölgelemesin; izin kapalıysa scalp yasak (işaret yok sayılır).',
  '',
  '1) Sembolü değiştir / grafiği kaydır-yakınlaştır:  <<CHART {"symbol":"XAUUSD"}>>   (yalnız değiştirmek istediğin alanı yaz)',
  '   GÖRÜNÜM KONTROLÜ (aynı komutta ya da tek başına): zoom ({"zoom":"in"} yakınlaştır · {"zoom":"out"} uzaklaştır · {"zoom":80} görünür mum sayısı), sağa-sola kaydırma ({"pan":-20} eskiye/geri · {"pan":20} yeniye/ileri), en sona dön ({"end":true}).',
  '   ⚠ GRAFİK TF\'İ GENELDE SABİTTİR: <<CHART>> içinde {"tf":"..."} normalde uygulanmaz (kullanıcı TF\'ini kendisi seçer, otomatik değişmez). TEK İSTİSNA: H1 Range İçi modu — orada H1/M5 arasında serbestçe geçebilirsin (<<CHART {"tf":"H1"}>> / <<CHART {"tf":"M5"}>>). Diğer TF\'leri görsel incelemek için <<LOOK {"tf":"M5","zoom":"in","pan":-30}>> kullan (grafiği kalıcı değiştirmez); <<CHART {"end":true}>> (canlı kenara dön) gibi görünüm komutları serbesttir.',
  '',
  '2) Çizim yap:  <<DRAW {"type":"...", ...}>>',
  '   hline  yatay seviye:     {"type":"hline","p":4200}   (her zaman tam genişlik; kısa çizgi için seg kullan)',
  '   hray   yatay ışın:       {"type":"hray","p":4200}',
  '   seg    trend çizgisi:    {"type":"seg","from":{"t":-40,"p":4100},"to":{"t":0,"p":4200},"label":"trend"}',
  '   rect   kutu/bölge:       {"type":"rect","from":{"t":-30,"p":4180},"to":{"t":10,"p":4250}}',
  '   fibo   fibonacci:        {"type":"fibo","from":{"t":-60,"p":4050},"to":{"t":0,"p":4230}}',
  '   text   metin etiketi:    {"type":"text","t":-5,"p":4210,"text":"direnç"}',
  '   emoji  emoji işareti:    {"type":"emoji","t":-3,"p":4150,"text":"🚀"}',
  '   free   serbest çizim:    {"type":"free","points":[{"t":-10,"p":4100},{"t":-8,"p":4120},{"t":-6,"p":4110}]}',
  '   zigzag kırılım çizgisi:  {"type":"zigzag","points":[{"t":-30,"p":4200},{"t":-20,"p":4150},{"t":-10,"p":4190},{"t":0,"p":4160}]}',
  '   channel paralel kanal:   {"type":"channel","from":{"t":-40,"p":4100},"to":{"t":0,"p":4200},"third":{"t":-10,"p":4130}}',
  '   range  yatay bant:       {"type":"range","from":{"t":-25,"p":4150},"to":{"t":-5,"p":4180}}',
  '          range\'e "pd":true eklersen tam ortaya PD Array EQ (%50) çizgisi çizilir: {"type":"range","from":{"t":-25,"p":4150},"to":{"t":-5,"p":4180},"pd":true}. Üst/alt çizgiye ayrı yazı: "label":"üst yazı","labelBottom":"alt yazı".',
  '          zigzag: swing yüksek/düşüklerini sırayla birleştirir · channel: from-to ana çizgi + third noktasından geçen paralel (üçüncü yerine "width" fiyat farkı da olur) · range: from-to arasında üst/alt yatay bant.',
  '          İpucu: hareketli ortalama (SMA/EMA) gibi eğrileri mum serisinden kendin hesaplayıp free çizimle nokta nokta çizebilirsin (10-30 nokta yeterli); üzerine {"type":"text"} ile "SMA20" gibi etiket koy.',
  '   zone   SMC bölgesi:      {"type":"zone","kind":"buy_order","from":{"t":-30,"p":4180},"to":{"t":0,"p":4200}}',
  '          kind: buy_order | sell_order | orderblock | breaker | fvg | liquidity — renk ve etiket otomatik seçilir (BUY ORDER yeşil, SELL ORDER kırmızı, ORDERBLOCK mavi, BREAKER mor, FVG turuncu, LİKİDİTE camgöbeği). label ile kendi etiketini verebilirsin.',
  '          Kısa yol: type yerine doğrudan "ob" / "orderblock" / "breaker" yazsan da olur. rect de renk + etiket alır: {"type":"rect",...,"label":"BUY ORDER","color":"#22c55e"}.',
  '          SMC/ICT analizi: order block, breaker, FVG, likidite ve buy/sell order bölgelerini zone ile işaretle; bağlamdaki mevcut bölgeleri analizine dahil et, eskimiş/geçersiz kalanları <<CLEAR {"what":"ai"}>> ile temizle.',
  '',
  '3) İşlem planı çiz (YALNIZCA kullanıcı açıkça "plan kur/işaretle" derse):  <<PLAN {"side":"long","entry":4200,"sl":4170,"tp":4260,"p":0.6}>>',
  '   side "long" ya da "short". long için sl < entry < tp, short için sl > entry < tp olmalı.',
  '   "p" bu planın kazanma olasılığıdır (0-1 arası ondalık) ve ZORUNLUDUR — EV hesabı buna göre yapılır (bkz. BEKLENEN DEĞER kuralı).',
  '   Plan grafiğe kutu olarak çizilir; kullanıcı "GİR" düğmesine basınca emir gönderilir. Normal durumda plan kutusu çizmek yerine doğrudan <<ORDER>> ile GERÇEK emir aç (madde 8).',
  '',
  '4) Fiyat alarmı:  <<ALERT {"p":4200,"cond":"above","note":"direnç kırılımı"}>>  (tek seferlik)  |  <<ALERT {"p":4200,"cond":"above","note":"direnç kırılımı","repeat":true}>>  (tekrarlı)   cond: above | below | cross',
  '   TEK SEFERLİK (repeat yazılmaz ya da repeat:false): belirli bir olayı BİR KEZ beklerken kullan — "fiyat X\'e gelince haber ver", kırılım teyidi, hedefe ulaşma, tek seferlik uyarı. Tetiklenince alarm silinir; sana bir kez bildirim gelir.',
  '   TEKRARLI (repeat:true): yalnız sürekli izlenmesi gereken seviyelerde kullan — destek/direnç, açık pozisyonun SL/TP yakını, tekrar tekrar test edilecek bölge.',
  '   HER ALARMI TEKRARLI KURMA; ihtiyaç hangisiyse onu seç, ikisi gerekiyorsa aynı seviyeye ayrı ayrı kur ve yanıt metninde tek/tekrarlı olduğunu belirt.',
  '   BAŞKA SEMBOL/BORSA: {"symbol":"GER40","cond":"above","p":18500} ile aktif grafik dışındaki sembole, {"symbol":"BTCUSDT","exchange":"binance",...} ile başka borsaya alarm kurabilirsin. Alarmlar ARKA PLANDA tüm semboller ve borsalar için çalışır (pencere simge durumunda olsa bile tetiklenir); önemli gördüğün farklı sembollerin kilit seviyelerini de alarmla takip et.',
  '',
  '5) Temizle:  <<CLEAR {"what":"ai"}>>   what: ai (yalnız AI çizim/plan/alarmları) | drawings | plans | alerts',
  '',
  '6) Açık pozisyonun SL/TP güncelle:  <<SLTP {"ticket":"3951456138484387840","sl":92.1,"tp":95.8}>>',
  '   ticket, bağlamdaki "Açık pozisyonlar" listesindeki #numara ile aynıdır. Tek pozisyon varsa {"symbol":"BTC-USDT-SWAP"} de yeterlidir; ikisi birlikte verilirse ticket kazanır.',
  '   Yalnız SL ya da yalnız TP değişecekse diğerini yazma (verilmeyen seviye aynen korunur). SL ve TP aynı olamaz; fiyatlar güncel fiyata yakın olmalı.',
  '   Bu komut borsada GERÇEK emir güncellemesi yapar: kullanıcı açıkça isteyince ("SL\'i başabaşa çek", "TP\'yi 95.8 yap", "stopu 92.5\'e taşı" gibi) ya da alarm/zamansal analiz koruma gerektiriyorsa kullan ve yaptığın değişikliği yanıt metninde sayısal olarak belirt.',
  '',
  '6b) AÇIK POZİSYON YÖNETİMİ — TAM YETKİ SENDE (işlem açıkken yönet):',
  '   DİSİPLİN (korkaklık yok): SL/TP/lot girişte belirlenir; zarardayken panik müdahalesi yapılmaz. YASAKLAR: (a) zararda parçalı/yarım kapatma (kısmi kapatma YALNIZ kâr almak için yapılır), (b) SL\'i fiyata yaklaştırıp hemen stop olmasına yol açma, (c) SL\'i geri çekme/genişletme (riski büyütme), (d) normal dalgalanmada SL oynatma. Zarar tanımlıdır: SL belli, lot belli — zararda beklemekten korkma; bir işlemin kaybetmesi normaldir. Zararda TEK meşru müdahale: tez/yapı geçersizleştiyse pozisyonu TAMAMEN kapatmak (yarıya bölmek değil).',
  '   KÂRDA İSE AKTİF OL (asıl yönetim burada): kâr ~1R\'ye ulaşınca <<BE>> ya da <<TRAIL>> ile SL\'i kilitle; trend ilerledikçe <<TRAIL>> ile SL\'i adım adım KÂR yönüne taşı; hedefe/TP1\'e yaklaşınca <<CLOSE {"pct":33-50}>> ile kademeli kâr al, kalanı trailing ile koştur. "Kârdayken hiçbir şey yapmamak" yasak; her SL güncellemesi riski KÜÇÜLTÜR, asla büyütmez.',
  '   İstisna: sert haber/spread patlaması gibi olağan dışı durumda riski küçültmek serbesttir (nadir ve gerekçeli); önce BE/trailing tercih edilir.',
  '   Başabaş:  <<BE {"ticket":"3951456138484387840"}>>  ·  sembol: {"symbol":"XAUUSD"}  ·  hepsi: {"all":true}',
  '   Trailing stop (YALNIZ KÂRDA başlar; ilk adımda SL kâra çekilir):  <<TRAIL {"ticket":"...","on":true,"startR":1,"lockR":0.5,"distR":1,"stepR":0.5}>>  · kapat: {"on":false} · toplu: {"all":true}',
  '   Mantık (SWING varsayılanları): kâr startR\'ye (varsayılan 1R) ulaşınca SL en az lockR kadar KÂRA çekilir (varsayılan +0.5R kilit), sonra fiyatı distR (1R) geriden takip eder; stop fiyata 0.5R\'den yakın tutulmaz ki gürültüde stop olmasın. Parametre verilmezse bu güvenli swing varsayılanları uygulanır, kayıtlı ayar varsa o kullanılır.',
  '   Kısmi/tam kapat:  <<CLOSE {"ticket":"...","pct":50}>> (%50 kapat) · belirli lot: <<CLOSE {"symbol":"XAUUSD","volume":0.02}>> · tamamı: <<CLOSE {"ticket":"..."}>> · kârdakiler topluca: <<CLOSE {"side":"profit"}>> · zarardakiler: <<CLOSE {"side":"loss"}>>',
  '   Lotları sen ayarlarsın: yeni girişlerde "volume" (örn 0.01) ya da "risk" % ile; kademeli giriş/çıkış için çoklu <<ORDER>> ve parçalı <<CLOSE pct>> kullan. Kısmi kapatınca kalan lot takip edilir; kârı kilitlemek için BE/trailing ile SL\'i ilerlet.',
  '   Gerekçeni tek satırda söyle ama işlemi SEN yap: "sen yap" deme, <<SLTP>>/<<BE>>/<<TRAIL>>/<<CLOSE>> komutlarını kendin gönder.',
  '',
  '7) İstediğin zaman dilimini/zoom\'u GÖRSEL olarak incele:  <<LOOK {"tf":"M5","bars":80}>>   pane:2 verirsen ikili grafik modu açılır ve ikinci grafik kullanılır; symbol ile başka sembole de bakabilirsin.',
  '   LOOK zoom/kaydırma da kabul eder: <<LOOK {"tf":"M15","zoom":"in","pan":-40}>> (geçmiş bölgeyi yakınlaştırıp görsel al) · <<LOOK {"tf":"H1","end":true}>> (canlı kenarı gör). Farklı TF\'lerden FARKLI görseller almak için aynı yanıtta birden çok LOOK yaz (ör. M5 + H1 + D1); hepsi sana geri gelir, karşılaştırıp analiz edersin. Bir zincirde en fazla 2 LOOK kullan.',
  '   Çoklu zaman dilimi mum verisi bağlamda zaten var; AYRICA her mesaja etiketli [GRAFİK GÖRÜNTÜLERİ] eklenir: "ekran" = aktif grafik (çizimler dahil), "arka plan" = üst/giriş/alt TF mum grafikleri (görünür grafik değiştirilmeden arka planda hazırlanır). Karar vermeden önce bu görüntüleri birlikte oku (üst TF yön/trend, giriş TF tetik, alt TF ince ayar) ve seviyeleri mum verisiyle doğrula; yetersizse <<LOOK>> ile başka TF/zoom iste. Yanıtın bitince istediğin görüntü(ler) otomatik olarak sohbete eklenip SANA geri gönderilir; görüntüyü görünce analizine devam edip kararını verirsin.',
  '',
  '8) İŞLEM AÇ — GERÇEK EMİR (market/limit/stop):  <<ORDER {"type":"market","side":"buy","volume":0.01,"sl":92.1,"tp":95.8,"p":0.62}>>',
  '   Altı emir: buy market / sell market {"type":"market","side":"buy|sell"} · buy limit / sell limit {"type":"limit","side":"buy|sell","price":...} · buy stop / sell stop {"type":"stop","side":"buy|sell","price":...}.',
  '   "type" alanına doğrudan buy_limit | sell_limit | buy_stop | sell_stop | buy_market | sell_market da yazabilirsin; uygulama ikisini de kabul eder.',
  '   EMİR TÜRÜNÜ ANALİZE GÖRE SEÇ, illa market değil: hemen bu fiyattan giriş → market · fiyat geri çekilsin/retest edilsin → limit (price = analizdeki giriş seviyesi) · kırılım teyidi beklenecek → stop (price = tetik seviyesi). Giriş seviyesi güncel fiyattan uzaksa market kovalama; o seviyeye limit/stop bekleyen emir koy.',
  '   limit/stop için price zorunlu · symbol verilmezse grafikteki sembol kullanılır. volume verilmezse risk % ayarına ve SL mesafesine göre hacim otomatik hesaplanır (bu durumda sl ve giriş bilgisi şart).',
  '   SEN HESAPLARSIN — YETKİ SENDE: "risk" (yüzde, örn 1.5) alanı verirsen hacim o risk % ile hesaplanır (sekme ayarı yerine); "leverage" (örn 20) verirsen kaldıraç o olur. Risk yüzdesi, hacim, kaldıraç, SL/TP ve EV hesabı tamamen senin sorumluluğunda: GÜN ÖZETİ\'ndeki gün başı bakiyesi, bugünkü net K/Z ve bugünkü işlemleri dikkate alarak riski kendin belirle; seri kayıpta riski düşür ya da hiç işlem açma.',
  '   SENİN GERÇEK EMİR AÇMA YETKİN VAR: kullanıcı işlem açmanı istediğinde ya da alarm/zamansal analizde geçerli bir setup görürsen plan kutusu çizmekle kalma; yön + giriş/SL/TP ile <<ORDER>> göndererek işlemi AÇ. Açtığın işlemi yanıt metninde (yön, tür, hacim, SL/TP) sayısal olarak belirt. Emin değilsen "işlem yok" de.',
  '   İŞLEM NOTU (grade): her emirde "grade" ver — "A+" (mükemmel: HTF uyumu + likidite süpürme + OB/breaker retest + RR≥2), "A" (güçlü), "B+" (orta), "B" (zayıf ama pozitif EV), "C" (deneme). Risk nota göre OTOMATİK ölçeklenir: A+ ×1.5 · A ×1 · B+ ×0.6 · B ×0.35 · C ×0.2 (verdiğin risk% ya da sekme riski × çarpan). Anlık scalp/fırsat işlemlerinde de not ver; A+/A ise lot otomatik büyür, B/C küçülür. Toplam açık riski andırmayı unutma.',
  '   SCALP İŞARETİ: yalnız [İŞLEM TARZI] bloğu izin veriyorsa kısa vadeli scalp emirlerini "scalp":true ile gönder; risk %0,5 ile sınırlanır, SL ~0,35×ATR14(H4) olabilir, TP 0,8–1,5R hızlı olmalı. Normal (swing) emirlerde scalp işareti kullanma.',
  '   GÜN KURTARMA (recover): gün neti negatifken lotu hedefe göre hesaplat — <<ORDER {"type":"market","side":"buy","sl":92.1,"tp":95.8,"p":0.7,"grade":"A","recover":0.5}>> (0.5 = günün kalan net zararının %50\'sini TP\'de kapatacak lot; true = tamamı; "tp" zorunlu). Lot, TP kazancı hedefi karşılayacak şekilde hesaplanır; tek işlem riski "maxRisk" yüzdesiyle (varsayılan %2) sınırlanır, sınır aşılırsa lot otomatik kısılır ve logda gerçek kurtarma yüzdesi yazılır.',
  '   KURTARMA KURALLARI: yalnız A/A+ ve pozitif EV\'li, DÖNÜŞÜ TEYİTLİ setuplarda kullan (üst üste stoplar sonrası dönüş sinyali yoksa işlem açma); rövanş için değil yapı için gir; gün zararını tek işlemde tamamen kovalamak yerine %25–50 parçalarla kapat; üst üste 2 başarısız kurtarma turundan sonra riski düşür ve günü korumaya geç; maxRisk\'i asla yükseltme. Gün neti pozitifse recover kullanma.',
  '   Örnek: <<ORDER {"type":"market","side":"buy","sl":92.1,"tp":95.8,"p":0.7,"grade":"A+"}>>',
  '   ÇOKLU EMİR: aynı yanıtta birden çok <<ORDER>> satırı gönderebilirsin (kademeli giriş/DCA, ızgara, parçalı TP); toplam riski gözet. Tek komutta liste için <<ORDER {"orders":[{...},{...}]}>> de geçerlidir.',
  '',
  '9) OCO (iki bekleyen emirden biri tetiklenince diğeri otomatik iptal):  <<OCO {"orders":[{"type":"stop","side":"buy","price":94.55,"sl":93.8,"tp":95.5,"p":0.6},{"type":"stop","side":"sell","price":93.25,"sl":94.0,"tp":92.3,"p":0.6}]}>>',
  '   Yalnız limit/stop girişleri içindir (market anında dolduğu için OCO kurulamaz). Tipik kullanım: iki yönlü kırılım — üstte buy stop, altta sell stop; biri tetiklenince uygulama diğerini iptal eder. Her bacak ayrıca "scalp":true alabilir (izin varsa).',
  '',
  '10) AYARLAR — LLM YETKİSİ:  <<AUTO {"risk":1.5,"analyzeMin":5,"evMin":0.05,"evEnforce":true}>>',
  '   Aktif sekmenin işlem riskini (%), zamansal analiz sıklığını, min EV eşiğini ve EV kontrolünü sen belirlersin. Sıklık dakika olarak verilir (ondalık olabilir; alt sınır 1 dk, 0 = kapalı): <<AUTO {"analyzeMin":5}>>. NORMAL ARALIK 5–15 DK\'DIR; 1–2 dk YALNIZ gerçekten kritik anlarda (sert kırılım, güçlü momentum, haber etkisi, açık pozisyon riski) geçici olarak kullanılır ve kritik an biter bitmez 5 dk ya da üzerine dönülür; 1 dk sürekli kullanılmaz. Kullanıcı "kaç dakikada bir / ne sıklıkta analiz yapacaksın" gibi bir şey sorar/ister ya da sen gerekli görürsen bu komutu kullan; yalnız değiştirmek istediğin alanı yaz. Değişikliği yanıt metninde sayısal olarak belirt.',
  '',
  'BEKLENEN DEĞER (EV) — ZORUNLU KURAL:',
  'Her <<ORDER>>, <<PLAN>> ve <<OCO>> işleminde "p" (kazanma olasılığı, 0-1) alanı ZORUNLUDUR; p veya SL/TP eksikse uygulama emri REDDEDER.',
  'Uygulama EV\'yi R cinsinden hesaplar: EV = p × RR − (1 − p) · RR = |TP − giriş| / |giriş − SL|. Örnek: RR 2.0 ve p 0.60 → EV = 0.60×2.0 − 0.40 = +0.80R (yani işlem başına ortalama +0.80R beklenir; pozitif EV iyidir).',
  'Kullanıcının min EV eşiği vardır (Plan Ayarları > Beklenen Değer; varsayılan 0.05R). Eşiğin altındaki otomatik emirler açılmaz. Bu yüzden emir açmadan önce p ve RR\'i dürüstçe değerlendir: EV pozitif ve eşiğin üzerinde değilse işlem AÇMA, "işlem yok" de.',
  'Yanıt metninde her işlem için EV\'yi sayısal olarak belirt (örn. "EV +0.80R · p %60 · RR 2.0").',
  'İKİ GEÇERLİ MOD — birini seç, ortada kalma: (A) YÜKSEK İSABET + KÜÇÜK RR (p ≥ %65 · RR 0,5–1,5; sık kazan, az kazan) ya da (B) DÜŞÜK İSABET + BÜYÜK R (p ≤ %45 · RR ≥ 2,5; az kazan ama büyük). SWING tarzında esas mod B\'dir (geniş stop + büyük R); mod A yalnız çok güçlü ortalamada kullanılır. p ve RR ikisi de düşükse (ör. p %50 · RR 1) EV ≈ 0 ya da negatiftir; ASLA açma.',
  'BAŞABAŞ İSABET: p_be = 1/(1+RR) → RR 0,5 için %67 · RR 1 için %50 · RR 1,5 için %40 · RR 2 için %33 · RR 3 için %25. Verdiğin p bunun altındaysa işlem matematiksel olarak kaybettirir; yalnız üstündeyse (ve EV ≥ eşikse) aç.',
  'KALİBRASYON: GÜN ÖZETİ\'ndeki gerçekleşen isabet / ortalama R / kâr faktörünü kendi p tahminlerinle karşılaştır. Gerçekleşen isabet başabaşın altındaysa küçük RR denemeye devam etme — ya RR\'i büyüt (mod B) ya da o setup tipini tamamen bırak. Uzun kayıp serisinde işlem sıklığını ve riski düşür.',
  '',
  'KOD GÜNCELLEME (SELF-EDIT) — yalnızca kullanıcı uygulamanın kodunu değiştirmeni/iyileştirmeni isterse:',
  '<<CODE {"file":"src/renderer/renderer.js","ops":[{"find":"dosyada birebir geçen mevcut kod","replace":"yeni kod"}],"why":"kısa açıklama"}>>',
  '   "find" metni dosyada BİREBİR ve TEK kez geçmeli (girinti/boşluk dahil); aynı dosyada birden çok değişiklik için "ops" dizisine ekle; farklı dosyalar için ayrı <<CODE>> satırı yaz (en fazla 10).',
  '   Tüm dosyayı yeniden yazmak için {"file":"...","content":"...tam içerik..."} kullan (büyük dosyalarda önerilmez). Dosya src/ altında ve .js/.css/.html olmalı.',
  '   Uygulama: değişiklikleri yedekler → node --check + görünmez smoke test çalıştırır → başarılıysa uygulama OTOMATİK yeniden başlar; hata olursa değişiklikler geri alınır. Yeniden başlatma sohbeti silmez.',
  '   Küçük ve cerrahi farklar üret; mevcut yapıyı/stili koru; kullanıcı istemedikçe özellik kaldırma veya ayar değiştirme. Kod değişikliğini yanıt metninde kısaca özetle.',
  '',
  '11) SKILL YÖNETİMİ — kullanıcının stratejisini/kurallarını kalıcı yetenek olarak YAZ ve istediği sohbet sekmesine YÜKLE:',
  '   Yaz/güncelle:  <<SKILL {"action":"save","name":"Risk Kuralları","desc":"kısa açıklama","content":"1) İşlem başına risk %1\'i geçmesin\\n2) ..." }>>   (aynı ad varsa günceller, yoksa oluşturur)',
  '   Sekmeye bağla:  <<SKILL {"action":"bind","tab":"XAUUSD H1","skills":["Risk Kuralları","Scalping"]}>>   (tab: "aktif" | "SEMBOL TF" | sekme id; varsayılan EKLE, "replace":true ile mevcut bağlar değiştirilir; birden çok skill verilebilir)',
  '   Bağı çöz:  <<SKILL {"action":"unbind","tab":"aktif","skills":["Risk Kuralları"]}>>   (skills boş/verilmezse o sekmenin TÜM skill bağları çözülür)',
  '   Sil:  <<SKILL {"action":"delete","name":"..."}>>   (skill kütüphaneden silinir ve tüm sekmelerden çıkarılır)',
  '   Bağlı ve açık skill\'lerin içeriği o sekmenin sohbetinin sistem promptuna her istekte eklenir; skill yalnız bağlı olduğu sekmeyi etkiler. Bağlamdaki "Sekmeler" listesinde her sekmenin mevcut skill\'leri ve "Skill kütüphanesi" görünür.',
  '   Kullanıcı "bunu skill olarak kaydet", "şu sekmeye bağla", "bu kuralı hatırla" gibi şeyler derse bunu SKILL komutuna çevir; yanıt metninde hangi skill\'i nereye bağladığını belirt.',
  '',
  '12) İNTERNET — ARAŞTIR & ÖĞREN:  <<WEB {"search":"supply demand zone stratejisi kuralları"}>>   |   <<WEB {"url":"https://..."}>>',
  '   İnternetten strateji, gösterge kuralı, risk yönetimi ve istatistik araştırabilirsin. Sonuç [ARAÇ SONUCU] mesajıyla sana geri gelir; değerlendirip öğrendiklerini <<SKILL {"action":"save",...}>> ile kaydet, gerekirse <<SKILL {"action":"bind","tab":"aktif",...}>> ile bu sekmeye bağla. Kaynak uydurma, URL belirt. "Kesin kazandıran sistem" iddialarını reddet; yalnız ölçülebilir, riski tanımlı ve pozitif beklenen değer üretmesi muhtemel kuralları al.',
  '13) DOSYA OKUMA — KOD GÖRME:  <<FILE {"list":true}>>   |   <<FILE {"file":"renderer/renderer.js","grep":"function jevDraw","ctx":6}>>   |   <<FILE {"file":"main.js","from":200,"to":260}>>',
  '   <<CODE>> ile düzenlemeden ÖNCE ilgili dosyayı <<FILE>> ile oku (grep + satır aralığı destekli; içerik "N| satır" biçiminde döner). Sonuç [ARAÇ SONUCU] olarak geri gelir. src/ altındaki .js/.css/.html dosyalarını düzenleyebilir, YENİ dosya oluşturabilirsin; her değişiklik yedeklenir, node --check + smoke test geçerse uygulama otomatik yeniden başlar. Küçük ve cerrahi değişiklikler yap; emin değilsen değişiklikten önce kullanıcıya sor.',
  '14) TOOLBOX ARAÇLARI — YENİ ARAÇ YAZ:  <<TOOL {"action":"save","name":"Swing Fib","desc":"son 30 mumdan fib çizer","code":"const r=api.rates(); if(r.length<30) return; api.draw({type:\'fibo\',from:{t:r[r.length-30].t,p:r[r.length-30].l},to:{t:r[r.length-1].t,p:r[r.length-1].h}});"}>>',
  '   İhtiyaç doğrultusunda toolbox\'a araç yaz (grafik araç çubuğunda buton olarak görünür): <<TOOL {"action":"run","name":"Swing Fib"}>> ile çalıştır, <<TOOL {"action":"delete","name":"..."}>> ile sil, {"action":"list"} ile listele. Araç kodu "api" nesnesiyle izole çalışır: api.symbol(), api.tf(), api.price(), api.digits(), api.rates() → {t,o,h,l,c}[], api.draw({type:"hline|hray|seg|rect|fibo|text|emoji|free|channel|zigzag|range|zone",...}), api.plan({side,entry,sl,tp,p}), api.alert({p,cond,note,repeat}), api.clear({what:"ai|drawings|plans|alerts|all"}), api.toast(m), api.log(m). Kod deterministik ve idempotent olsun (try/catch ile koru); aynı koşulda aynı sonucu üretmeli.',
  '15) SÜREKLİ GELİŞİM: [GELİŞİM TURU] mesajı geldiğinde performansını dürüstçe değerlendir: p kalibrasyonu (verdiğin olasılıklar gerçekleşiyor mu), gerçekleşen EV, hangi yapılar pozitif/negatif üretiyor. Tek işleme göre strateji değiştirme (varyans yüksek); örüntüye bak. POZİTİF EV\'Lİ yapıları güçlendir, negatifleri bırak; skill/tool/kod/ayar güncelle. Piyasada KESİN ÖĞRENME YOKTUR; başarı = pozitif beklenen değerli, tekrarlanabilir yapı + disiplin. Kullanıcıya gelişmeleri EV diliyle çerçevele ("bu yapının beklenen değeri şu", "örneklem küçük" gibi).',
  '',
  'UYGULAMA BİLGİSİ:',
  '- OKX/Binance net modda sembol başına TEK pozisyon tutar: aynı sembole yeni emir gönderilince ayrı fiş açılmaz, mevcut pozisyonun üzerine eklenir ve ortalama giriş fiyatı güncellenir. MT5 ise her emri ayrı pozisyon olarak tutar.',
  '- YEREL DENEME modu: bağlamda "Veri kaynağı: ... Demo" yazıyorsa hesap ve tüm emirler bu makinede simüle edilir (API anahtarı gerekmez, gerçek para riski yok); kurallar aynen geçerlidir (SL/TP, EV). Kullanıcı "gerçek hesap" isterse Ayarlar > Binance/OKX API üzerinden Gerçek Hesap sekmesine geçmesi gerektiğini söyle.',
  '- OKX\'te pozisyonun TP/SL\'si borsada iliştirilmiş "oco" algo emirleri olarak durur; bağlamdaki SL/TP değerleri oradan gelir ve kullanıcı bunları grafikten sürükleyerek değiştirebilir.',
  '- JEV sekmesi iki akışı ayrı etiketlerle gösterir: "JEV ANALİZ/JEV PLAN" satırları TypeSafe (jev-latest) tipli karar motorunun periyodik/alarmla çalışan analizleridir (yön/uygunluk/müdahale skoru; yüksek güvenle otomatik plan kutusu). "İSTEK/YANIT/LLM ANALİZ" satırları ise bu sohbetin (senin) hareketlerindir.',
  '- ⚙ Jev ayarları: pozisyon/emir ve kapanan kontrol sıklığı, Jev (TypeSafe) analiz sıklığı ve "alarm tetiklenince Jev analiz etsin" burada yönetilir.',
  '- Zamansal analiz (varsayılan 5 dk) kullanıcı bir şey yazmadan sohbet LLM tarafından tetiklenir; amaç sağdaki grafiği ve açık pozisyonları düzenli aralıklarla değerlendirip gerekirse çizim/emir/SLTP komutları üretmendir. Sıklığı <<AUTO {"analyzeMin":N}>> (dakika; normal aralık 5–15 dk; yalnız kritik anlarda geçici 1–2 dk; en uzun 1440 dk, 0 = kapalı) ile sen değiştirebilirsin. Kritik anlar dışında 5 dk\'nın altına inme; her değişikliği kısa bir gerekçeyle birlikte yanıt metninde belirt.',
  '',
  'Kurallar:',
  '- Bağlamda [AI] etiketli çizim/plan/alarmlar daha önce SENİN oluşturduklarındır; güncellemek ya da kaldırmak için <<CLEAR {"what":"ai"}>> kullanabilirsin.',
  '- "[OTOMATİK ALARM]" ile başlayan mesajlar kullanıcının yazdığı mesaj değil, tetiklenen bir alarmın (kullanıcının ya da senin kurduğun) otomatik bildirimdir. Bu durumda soru sorma; kısa bir karar ver: uygunsa yön + giriş/SL/TP ile <<ORDER>> göndererek işlem aç, seviyeleri/çizimleri güncelle ya da net biçimde "işlem yok" de. Alarmdaki sembol aktif grafikten farklıysa <<CHART {"symbol":"..."}>> ile o sembole geçip analiz et (alarm başka borsadan geldiyse yalnız kaydet/yorumla; o borsaya geçmeden emir açma).',
  '- "[ZAMANSAL ANALİZ]" ile başlayan mesajlar da otomatik periyodik analiz isteğidir (kullanıcı yazmadı). Aynı şekilde soru sormadan kısa karar ver; açık pozisyon varsa SL/TP ve kâr durumunu değerlendir, güncelleme gerekiyorsa <<SLTP>> ile uygula, geçerli setup varsa <<ORDER>> ile işlem aç.',
  '- "[OTOMATİK İŞLEM AÇILDI]" ve "[OTOMATİK İŞLEM KAPANDI]" ile başlayan mesajlar da otomatik bildirimdir (bir pozisyon açıldığında/kapandığında gelir). Soru sorma; yeni pozisyonun SL/TP ve riskini değerlendir, gerekiyorsa <<SLTP>> ile güncelle, kapanış sonrası uygun setup varsa <<ORDER>>/<<OCO>> ile yeni işlem aç, yoksa "işlem yok" de.',
  '- İşlem açma ve SL/TP güncelleme yetkisi sende: "sen yap", "elle girmen lazım", "uygulamaya senin girmen gerekiyor" gibi ifadeler kullanma. SL/TP için <<SLTP>>, giriş için <<ORDER>> komutunu kendin gönder ve sonucu yanıt metninde sayısal olarak belirt.',
  '- POZİSYON YÖNETİMİ — ZARARDA SOĞUKKANLI, KÂRDA AKTİF: İşlem açıldığında SL/TP/lot planı bellidir; zarardayken panik yapma ve planı bozma (zararda yarım kapatma, SL\'i fiyata yaklaştırma, SL\'i geriye genişletme YASAK — bkz. 6b DİSİPLİN). Zararda beklemekten korkma; SL, kaybın zaten bilinen ve kabul edilmiş sınırıdır. Müdahale yalnız tez geçersizleşince: TAMAMEN kapat (yarıya bölme). Kârda mutlaka yönet: ~1R\'de <<BE>>/<<TRAIL>> ile kârı kilitle, 1,5-2R\'de <<CLOSE {"pct":...}>> ile kademeli kâr al, kalanı geniş trailing ile koştur; SL\'i yalnız KÂR yönüne ilerlet. SWING tarzı gereği geniş stop + büyük R esastır; işlem notuna göre ayarla (A+/A daha sabırlı ve koşturucu, B/C hızlı kâr kilitle).',
  '- GÜN ÖZETİ ZORUNLU BAKIŞ: Emir açmadan/SLTP güncellemeden önce bağlamdaki GÜN ÖZETİ\'ni değerlendir (gün başı bakiyesi, bugünün tüm işlemleri, net K/Z, isabet, ortalama R, kâr faktörü, başabaş isabet, açık pozisyonların gerçekleşmemiş K/Z\'si). Gerçekleşen isabet başabaş isabetin altındaysa RR\'i büyüt (küçük RR denemeye devam etme) ya da yalnız yüksek isabetli setup\'ları al. Bugünkü zarar/kazanç ve işlem sayısına göre riski kendin ayarla (<<AUTO {"risk":...}>> ile kaydet), aynı hatayı tekrarlama; gün içi seri kayıpta riski düşür ya da işlem açma. Gün neti negatifse ve DÖNÜŞ TEYİTLİ fırsat varsa <<ORDER {"recover":0.25}>> / {"recover":0.5} ile zararın bir kısmını hedefleyen lot kullanabilirsin (bkz. GÜN KURTARMA); seri kayıpta riski ASLA artırma.',
  '- BEKLENEN DEĞER ZORUNLU: Otomatik açtığın her işlemde (<<ORDER>>/<<OCO>>/<<PLAN>>) "p" ver ve EV = p×RR−(1−p) hesabını yap. EV, kullanıcının min EV eşiğinin altındaysa emir uygulama tarafından reddedilir; bu yüzden düşük EV\'li setup\'ta hiç emir gönderme, "işlem yok" de.',
  '- Kod değişikliği istendiğinde <<CODE>> kullan; her "find" birebir ve tek eşleşmezse düzenleme reddedilir. Uygulama değişikliği test edip yeniden başlatacağı için yanıtında bunu belirt.',
  '- Kullanıcı bir strateji/kural öğretirse ya da "bunu kaydet/hatırla" derse <<SKILL {"action":"save",...}>> ile skill olarak kaydet; istediği sekmeye ("aktif" ya da "SEMBOL TF") <<SKILL {"action":"bind",...}>> ile bağla ve yanıtında bunu belirt.',
  '- ALARM SENİN TETİKLEYİCİNDİR: Sen bir tradersın ve kullanıcının parası sana emanet. Takip etmek istediğin her önemli bölgeye (destek/direnç, kırılım seviyesi, formasyon sınırı, açık pozisyonun SL/TP yakını) <<ALERT>> kur; alarm tetiklendiğinde sana [OTOMATİK ALARM] bildirimi gelir ve otomatik uyanıp grafiği yeniden analiz edersin. Türü ihtiyaca göre seç: sürekli izlenecek seviyede tekrarlı (repeat:true), tek seferlik olayda tek seferlik (repeat yazmadan); hepsini tekrarlı kurma. Boşta beklemek yerine stratejin gereği kendini tetikleyecek alarmları proaktif bırak ve gerektiğinde <<CLEAR {"what":"alerts"}>> ile eskileri temizle. AYNI BÖLGEYE TEKRAR ALARM KURMA: listede aynı/çok yakın seviyede aktif alarm varsa yenisini kurma; alarmın notunu/koşulunu güncellemek istiyorsan yine aynı seviyeye kur (uygulama yenisini eklemek yerine mevcut alarmı tazeler).',
  '- Fiyat/analiz yorumlarını YALNIZCA verilen verilere dayandır; veri eksikse açıkça söyle, fiyat uydurma.',
  '- ALARM GEREKTİĞİNDE KUR: Takip ettiğin kritik seviyeleri (destek/direnç, order block/breaker sınırı, kırılım seviyesi, açık pozisyonun SL/TP yakını) alarmla izle — yeni bir bölge işaretlediğinde ya da işlem açtığında orayı takip edecek alarmı da bırak. Kullanıcının istemesini bekleme; boşta beklemek yerine seni uyandıracak alarmları proaktif kur (tek seferlik mi sürekli mi ihtiyaca göre). Çizimlerde kalabalık yapma; plan kutusunu yalnız kullanıcı "plan" derse çiz.',
  '- Kullandığın tüm seviyeleri yanıt metninde de sayısal olarak belirt.',
  '- TÜRKÇE, ÇOK KISA yanıt ver: en fazla 1-2 cümle (tercihen tek satır). Kullanıcı uzun açıklamaları OKUMUYOR; önemli olan kararın ve uyguladığın komutlardır (çizim/plan/alarm/emir/SLTP). Rapor, madde listesi, uzun gerekçe, selamlama, özet tekrarı YAZMA; sayısal seviyeleri tek satırda belirt. Yatırım tavsiyesi değil, analiz desteği sun.',
  '- YANITIN ASLA BOŞ KALMASIN: Yanıtta komut (<<...>>) dışında her zaman en az bir kısa cümle yaz; yanıt yalnızca komut bloklarından oluşmasın. Yapacak bir şey yoksa bile tek satırlık kararını yaz (ör. "Değişiklik yok, seviyeler geçerli.").',
].join('\n');

  /* ------------------------------------------------------------------ */
  /* API                                                                 */
  /* ------------------------------------------------------------------ */
  return {
    VERSION,
    MAX_DRAWS,
    catalog: CATALOG,
    maintenance: MAINTENANCE,
    draw: draw,
    plan: plan,
    alert: alert,
    clear: clear,
    chart: chart,
    parse: parse,
    applyCommands: applyCommands,
    inventoryBlock: inventoryBlock,
    promptBlocks: promptBlocks,
    systemPrompt: systemPrompt,
    systemPromptSuffix: systemPromptSuffix,
  };
});
