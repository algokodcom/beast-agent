/* KONUŞMA MODU — tam ekran, eller serbest, gerçek sohbet.
   Ortada modern YZ küresi: beyaz cam çekirdek, nefes alan halo,
   ses düzeyine tepki veren genişleyen dalga halkaları ve etrafında
   dönen ses çubukları. Boşta hafif nefes, dinlerken mikrofon seviyesine
   tepki, konuşurken TTS ses düzeyiyle senkron dalgalanma. Bas-konuş YOK —
   createPanel zaten eller serbest döngüyü (barge-in, yankı filtresi,
   otomatik gönderim) yönetir; bu mod sadece görünüm + odaktır.
   TTS zorlaması renderer tarafında yapılır. */
(() => {
  let overlay = null;
  let orb = null, coreGlow = null, barsG = null, rippleA = null, rippleB = null, rippleC = null;
  let statusEl = null, draftEl = null, hintEl = null, engEl = null;
  let engTimer = 0;
  let panel = null;
  let open = false;
  let uiHidden = false; // ekrana dizilir: oturum SÜRER, overlay saklanır
  let peek = null;
  let onClosedCb = null;
  let tFn = (k) => k;
  let hfState = 'idle';
  let statusMsg = '';
  let micLevel = 0;
  let raf = 0;
  let stNow = '';
  let lastSpeak = false; // konuşma ilerleme flash: oynatma bitti anını yakalar
  let flashTs = 0;

  const STYLE_ID = 'convModeStyle';

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const css = document.createElement('style');
    css.id = STYLE_ID;
    css.textContent = `
#convOverlay {
  position: fixed; inset: 0; z-index: 9000;
  display: flex; align-items: center; justify-content: center;
  background: radial-gradient(1200px 700px at 50% 40%, #111a29 0%, #0a0e17 55%, #060810 100%);
  color: #8fa3bd;
  opacity: 0; transition: opacity 220ms ease;
}
#convOverlay[hidden] { display: none; }
#convOverlay.conv-in { opacity: 1; }
#convOverlay[data-st="listening"] { color: #7dd3fc; }
#convOverlay[data-st="thinking"] { color: #c4b5fd; }
#convOverlay[data-st="speaking"] { color: #6ee7b7; }
#convClose {
  position: absolute; top: 14px; right: 16px; width: 38px; height: 38px;
  border-radius: 10px; border: 1px solid #232c3d; background: #0f1522;
  color: #8b9ab0; font-size: 20px; line-height: 1; cursor: pointer;
}
#convClose:hover { color: #e8eef8; border-color: #33405a; }
#convHide {
  position: absolute; top: 14px; right: 64px; width: 38px; height: 38px;
  border-radius: 10px; border: 1px solid #232c3d; background: #0f1522;
  color: #8b9ab0; font-size: 15px; line-height: 1; cursor: pointer;
}
#convHide:hover { color: #e8eef8; border-color: #33405a; }
#convPeek {
  position: fixed; left: 50%; transform: translateX(-50%); bottom: 16px;
  z-index: 8900; display: inline-flex; align-items: center; gap: 9px;
  padding: 9px 15px; border-radius: 999px; border: 1px solid #233047;
  background: rgba(13, 19, 31, 0.94); color: #9fb0c7; font-size: 13px;
  cursor: pointer; box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
  transition: color 200ms ease, border-color 200ms ease;
}
#convPeek:hover { color: #e8eef8; border-color: #33405a; }
#convPeek .dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: #34d399; box-shadow: 0 0 6px #34d399;
  animation: convEngPulse 1.2s ease infinite;
}
#convStage { display: flex; flex-direction: column; align-items: center; gap: 16px; max-width: 620px; padding: 28px 20px 34px; }
#convOrbSvg {
  width: min(42vw, 320px); height: auto;
  filter: drop-shadow(0 0 46px rgba(150, 200, 255, 0.20));
  transition: color 500ms ease;
}
#convOrb, #convRingA, #convRingB, #convRingC { transform-box: fill-box; transform-origin: center; }
#convStatus {
  min-height: 21px; font-size: 15px; letter-spacing: 0.3px;
  color: #9fb0c7; transition: color 400ms ease;
}
#convOverlay[data-st="listening"] #convStatus { color: #7dd3fc; }
#convOverlay[data-st="thinking"] #convStatus { color: #c4b5fd; }
#convOverlay[data-st="speaking"] #convStatus { color: #6ee7b7; }
#convDraft {
  min-height: 52px; max-width: 560px; text-align: center;
  font-size: 19px; line-height: 1.45; color: #e8eef8; opacity: 0.94;
}
#convHint { font-size: 12.5px; color: #5f6d84; text-align: center; }
#convEngines { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
#convEngines .eng {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 10px; border: 1px solid #232c3d; border-radius: 999px;
  background: #0f1522; font-size: 12px; color: #8b9ab0; cursor: pointer;
  transition: border-color 200ms ease, color 200ms ease;
}
#convEngines .eng:hover { border-color: #33405a; color: #e8eef8; }
#convEngines .eng i { width: 7px; height: 7px; border-radius: 50%; background: #3a4557; }
#convEngines .eng.ok { color: #b9f6d8; border-color: #1d4a36; }
#convEngines .eng.ok i { background: #34d399; box-shadow: 0 0 6px #34d399; }
#convEngines .eng.warm { color: #fde8b7; border-color: #4a3d1d; }
#convEngines .eng.warm i { background: #fbbf24; animation: convEngPulse 1s ease infinite; }
#convEngines .eng.err { color: #f8c4c4; border-color: #4a2323; }
#convEngines .eng.err i { background: #f87171; }
@keyframes convEngPulse { 50% { opacity: 0.35; } }
`;
    document.head.appendChild(css);
  }

  const BAR_COUNT = 44;   // dönen ses çubukları
  const ORB_R = 64;       // küre yarıçapı
  const BAR_R0 = 84;      // çubuk iç yarıçap
  const BAR_LEN = 30;     // çubuk uzunluk payı

  function build() {
    if (overlay) return;
    injectStyle();
    overlay = document.createElement('div');
    overlay.id = 'convOverlay';
    overlay.hidden = true;
    overlay.dataset.st = 'idle';

    /* çubuklar daireye yerleştirilir; her biri radyal çizgi */
    let bars = '';
    for (let i = 0; i < BAR_COUNT; i++) {
      bars += `<line x1="0" y1="0" x2="0" y2="0" transform="rotate(${((i / BAR_COUNT) * 360).toFixed(2)})" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-opacity="0.55"/>`;
    }

    overlay.innerHTML = `
  <button id="convHide" title="" aria-label="minimize">─&#xFE0E;</button>
  <button id="convClose" title="" aria-label="close">&#x2715;&#xFE0E;</button>
  <div id="convStage">
    <svg id="convOrbSvg" viewBox="0 0 360 360" fill="none" aria-hidden="true">
      <defs>
        <radialGradient id="convCore" cx="0.38" cy="0.34" r="0.9">
          <stop offset="0" stop-color="#ffffff"/>
          <stop offset="0.45" stop-color="#eaf2ff"/>
          <stop offset="0.85" stop-color="#b7cdf0"/>
          <stop offset="1" stop-color="#8fa9d6"/>
        </radialGradient>
        <radialGradient id="convHaloGr" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stop-color="currentColor" stop-opacity="0.28"/>
          <stop offset="0.7" stop-color="currentColor" stop-opacity="0.08"/>
          <stop offset="1" stop-color="currentColor" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <circle id="convRingA" cx="180" cy="180" r="96" stroke="currentColor" stroke-width="1.5" stroke-opacity="0.16"/>
      <circle id="convRingB" cx="180" cy="180" r="130" stroke="currentColor" stroke-width="1.5" stroke-opacity="0.12"/>
      <circle id="convRingC" cx="180" cy="180" r="164" stroke="currentColor" stroke-width="1.5" stroke-opacity="0.08"/>
      <circle id="convHalo" cx="180" cy="180" r="${ORB_R + 28}" fill="url(#convHaloGr)"/>
      <g id="convBars" transform="translate(180,180)">${bars}</g>
      <circle id="convOrb" cx="180" cy="180" r="${ORB_R}" fill="url(#convCore)"/>
    </svg>
    <div id="convStatus"></div>
    <div id="convDraft"></div>
    <div id="convEngines"></div>
    <div id="convHint"></div>
  </div>`;
    document.body.appendChild(overlay);
    orb = overlay.querySelector('#convOrb');
    coreGlow = overlay.querySelector('#convHalo');
    barsG = overlay.querySelector('#convBars');
    rippleA = overlay.querySelector('#convRingA');
    rippleB = overlay.querySelector('#convRingB');
    rippleC = overlay.querySelector('#convRingC');
    statusEl = overlay.querySelector('#convStatus');
    draftEl = overlay.querySelector('#convDraft');
    hintEl = overlay.querySelector('#convHint');
    engEl = overlay.querySelector('#convEngines');
    /* rozete tık = motoru hemen ısıt */
    engEl.addEventListener('click', (ev) => {
      const chip = ev.target && ev.target.closest ? ev.target.closest('.eng') : null;
      if (!chip || !window.beast) return;
      if (chip.dataset.eng === 'stt') void window.beast.sttPrefetchNow().catch(() => {});
      else void window.beast.emaPrefetch().catch(() => {});
      setTimeout(pollEngines, 250);
    });
    overlay.querySelector('#convClose').addEventListener('click', () => closeInternal(false));
    /* gizle: oturum sürer, ana ekran görünür — dönmek için alt chip'e tıkla */
    overlay.querySelector('#convHide').addEventListener('click', hideOverlay);
    document.addEventListener('keydown', (e) => {
      if (!open || uiHidden || e.key !== 'Escape') return;
      e.preventDefault();
      closeInternal(false);
    });
  }

  /* ---------- MOTOR ROZETLERİ: STT (Duyu-small) + TTS (eMa) canlı durum ----------
     hazır = motor bellekte (anında çalışır) · ısınıyor = yükleniyor ·
     bekliyor = kurulu ama bellekte değil (ilk kullanımda yüklenir) ·
     kurulu değil = paket/model eksik. Rozete tık = hemen ısıt. */
  async function pollEngines() {
    if (!engEl || !engTimer) return;
    let stt = { cls: '', label: tFn('conv_standby') };
    let tts = { cls: '', label: tFn('conv_standby') };
    try {
      const s = (window.beast && (await window.beast.sttStatus())) || {};
      if (s.state === 'ready') stt = { cls: 'ok', label: tFn('conv_ready') };
      else if (s.state === 'loading' || s.installing) stt = { cls: 'warm', label: tFn('conv_warming') };
      else if (!s.installed) stt = { cls: 'err', label: tFn('conv_missing') };
    } catch {}
    try {
      const e = (window.beast && (await window.beast.emaStatus())) || {};
      if (e.running) tts = { cls: 'ok', label: tFn('conv_ready') };
      else if (e.installing) tts = { cls: 'warm', label: tFn('conv_warming') };
      else if (!e.installed) tts = { cls: 'err', label: tFn('conv_missing') };
    } catch {}
    const chip = (eng, name, st) =>
      `<span class="eng ${st.cls}" data-eng="${eng}"><i></i>${name} ${st.label}</span>`;
    engEl.innerHTML = chip('stt', tFn('conv_stt'), stt) + chip('tts', tFn('conv_tts'), tts);
  }

  /* ---------- EKRAN GİZLEME: oturum ARKA PLANDA SÜRER ----------
     "─" düğmesi overlay gizler, ana ekran görünür (dahili tarayıcı vs.).
     Alt ortada canlı chip: durum yazısı + tek tıkla tekrar açma. ✕ hâlâ tam kapanır. */
  function updatePeekText() {
    if (!peek) return;
    const txt = peek.querySelector('.txt');
    if (txt) txt.textContent = statusMsg ? `${tFn('conv_peek')} · ${statusMsg}` : tFn('conv_peek');
  }

  function hidePeek() {
    if (!peek) return;
    peek.remove();
    peek = null;
  }

  function showPeek() {
    if (peek || !open) return;
    peek = document.createElement('button');
    peek.id = 'convPeek';
    peek.appendChild(Object.assign(document.createElement('span'), { className: 'dot' }));
    peek.appendChild(Object.assign(document.createElement('span'), { className: 'txt' }));
    updatePeekText();
    peek.addEventListener('click', showOverlay);
    document.body.appendChild(peek);
  }

  function hideOverlay() {
    if (!open || uiHidden) return;
    uiHidden = true;
    cancelAnimationFrame(raf);
    raf = 0;
    overlay.classList.remove('conv-in'); // opacity 0 → 240ms sonra gizle
    setTimeout(() => { if (uiHidden) overlay.hidden = true; }, 240);
    showPeek();
  }

  function showOverlay() {
    if (!open || !uiHidden) return;
    uiHidden = false;
    hidePeek();
    overlay.hidden = false;
    requestAnimationFrame(() => overlay.classList.add('conv-in'));
    raf = requestAnimationFrame(loop);
  }

  function loop(ts) {
    if (!open || uiHidden) return;
    const st = window.BeastHandsFree && window.BeastHandsFree.ttsState;
    const speaking = !!(st && st.playing);
    const ttsLevel = st ? Math.min(1, st.level || 0) : 0;
    const eff = speaking
      ? 'speaking'
      : hfState === 'listening'
        ? 'listening'
        : hfState === 'thinking' || hfState === 'transcribing'
          ? 'thinking'
          : 'idle';

    /* aktif ses düzeyi: konuşurken TTS, dinlerken mikrofon */
    const lv = eff === 'speaking' ? ttsLevel : eff === 'listening' ? micLevel : 0;
    const lvl = Math.max(0, Math.min(1, lv));

    /* küre: boşta hafif nefes + sesle büyüme */
    const breathe = 1 + 0.025 * Math.sin(ts / 900);
    const puff = 1 + lvl * 0.10 + 0.03 * Math.sin(ts / 160) * lvl;
    orb.setAttribute('transform', `translate(180 180) scale(${(breathe * puff).toFixed(4)}) translate(-180 -180) rotate(${(eff === 'thinking' ? Math.sin(ts / 2200) * 6 : Math.sin(ts / 5000) * 3).toFixed(2)} 180 180)`);
    /* çekirdek iç parıltı */
    orb.style.opacity = String(0.82 + 0.18 * (1 - lvl * 0.35));

    /* halo: sesle canlanır */
    coreGlow.setAttribute('transform', `translate(180 180) scale(${(breathe * puff * 1.05).toFixed(4)}) translate(-180 -180)`);
    coreGlow.style.opacity = String(0.35 + 0.65 * lvl);

    /* genişleyen dalga halkaları: ses varken büyür, yokken sakin yüzme */
    const walk = (el, phase, baseR, span) => {
      const t = ((ts / 1000) % 1 + phase) % 1; // 0..1 sardisen
      const r = baseR + t * span;
      const fade = Math.pow(1 - t, 2);
      const boost = eff === 'idle' ? 0.35 : 1;
      el.setAttribute('r', r.toFixed(1));
      el.style.opacity = String((0.05 + 0.45 * fade * (0.35 + lvl)) * boost);
    };
    walk(rippleA, 0.00, 92, 70);
    walk(rippleB, 0.33, 92, 70);
    walk(rippleC, 0.66, 92, 70);

    /* dönen ses çubukları: sesle dalgalanır, boşta minik kılpıntı */
    const lines = barsG.children;
    for (let i = 0; i < lines.length; i++) {
      const ph = i * 0.55;
      /* salınım: sesle cukur, boşta minik */
      const wave = Math.abs(Math.sin(ts / 260 + ph)) * (0.18 + lvl);
      const extra = Math.abs(Math.sin(ts / 640 + ph * 0.5)) * 0.35 * lvl;
      const len = Math.min(1, wave + extra + 0.06);
      const rIn = BAR_R0 + 2;
      const rOut = rIn + BAR_LEN * len;
      lines[i].setAttribute('y1', (-rIn).toFixed(1));
      lines[i].setAttribute('y2', (-rOut).toFixed(1));
      lines[i].style.opacity = String(0.3 + len * 0.7);
      /* güçlü çubuklarda hafif parıltı */
      lines[i].style.filter = len > 0.8 ? 'drop-shadow(0 0 4px currentColor)' : '';
    }
    /* çubuk halkası yavaşça döner */
    barsG.setAttribute('transform', `translate(180,180) rotate(${(eff === 'idle' ? ts / 260 : ts / 90).toFixed(2) % 360})`);

    if (stNow !== eff) {
      stNow = eff;
      overlay.dataset.st = eff;
    }

    /* KONUŞMA İLERLEME: TTS cümle cümle çalar — kullanıcı "bitti mi?" bilmeli.
       cümle N/M ve "(son)"; cümle arası "sıradaki geliyor"; sonda kısa "bitti" vurgusu. */
    let endFlash = false;
    if (st && (st.total > 0 || lastSpeak)) {
      if (speaking) {
        lastSpeak = true;
      } else if (lastSpeak) { // oynatma az önce döndü
        lastSpeak = false;
        if (st.total > 0 && st.done >= st.total && !st.streamOpen) flashTs = ts;
      }
      if (flashTs && ts - flashTs < 1800) endFlash = true;
    }
    const pieceLabel = () => {
      if (!st || st.total <= 1) return tFn('conv_speaking');
      const cur = Math.min(st.total, st.done + 1);
      const isLast = cur >= st.total && !st.streamOpen;
      return `${tFn('conv_speaking')} · ${cur}/${st.total}${isLast ? ` · ${tFn('conv_last')}` : ''}`;
    };
    const moreComing = !!(st && st.total > 0 && st.done < st.total); // kuyrukta konuşulmamış cümle var
    const label = speaking
      ? pieceLabel()
      : endFlash
        ? tFn('conv_done')
        : moreComing
          ? tFn('conv_next')
          : statusMsg;
    if (statusEl.textContent !== label) statusEl.textContent = label || tFn('hf_listening');

    raf = requestAnimationFrame(loop);
  }

  function openConversation(cfg) {
    if (open) return;
    if (!window.BeastHandsFree) return;
    tFn = cfg.t || ((k) => k);
    onClosedCb = cfg.onClosed || null;
    build();
    hintEl.textContent = tFn('conv_hint');
    overlay.querySelector('#convClose').title = tFn('conv_exit');
    overlay.querySelector('#convHide').title = tFn('conv_hide');
    hfState = 'idle';
    statusMsg = '';
    micLevel = 0;
    stNow = '';
    lastSpeak = false;
    flashTs = 0;
    draftEl.textContent = '';
    uiHidden = false;
    hidePeek();
    open = true;
    overlay.hidden = false;
    requestAnimationFrame(() => overlay.classList.add('conv-in'));
    /* motor rozetleri canlı izlenir */
    clearInterval(engTimer);
    engTimer = setInterval(() => { void pollEngines(); }, 1200);
    void pollEngines();
    /* panel butonu görünmez kukla: gerçek tıklama convBtn'de bizde;
       panelin kendi tık dinleyicisi çift tetikleme yapmasın */
    const dummyBtn = document.createElement('button');
    dummyBtn.style.display = 'none';
    panel = window.BeastHandsFree.createPanel({
      btn: dummyBtn,
      isBusy: cfg.isBusy,
      submit: cfg.submit,
      transcribe: cfg.transcribe,
      draft: (text) => { if (draftEl) draftEl.textContent = text || ''; },
      interrupt: cfg.interrupt,
      cutTts: cfg.cutTts,
      status: (m) => {
        statusMsg = m || '';
        if (uiHidden) updatePeekText();
      },
      statusHide: () => {
        statusMsg = '';
        if (uiHidden) updatePeekText();
      },
      toast: cfg.toast || (() => {}),
      t: tFn,
      onState: (s) => {
        hfState = s;
        if (s !== 'listening' && draftEl) draftEl.textContent = '';
        if (uiHidden) updatePeekText();
      },
      onLevel: (v) => { micLevel = v; },
      onEnd: () => { closeInternal(true); },
    });
    void panel.start();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(loop);
  }

  function closeInternal(fromPanel) {
    if (!open) return;
    open = false;
    uiHidden = false;
    hidePeek();
    cancelAnimationFrame(raf);
    raf = 0;
    clearInterval(engTimer);
    engTimer = 0;
    if (engEl) engEl.innerHTML = '';
    overlay.classList.remove('conv-in');
    overlay.hidden = true;
    const p = panel;
    panel = null;
    if (!fromPanel && p && p.active) p.end(); // onEnd → closeInternal(true): erken döner
    const cb = onClosedCb;
    onClosedCb = null;
    if (cb) { try { cb(); } catch {} }
  }

  window.BeastConversation = {
    open: openConversation,
    close: () => closeInternal(false),
    show: showOverlay,
    isHidden: () => uiHidden,
    isOpen: () => open,
  };
})();
