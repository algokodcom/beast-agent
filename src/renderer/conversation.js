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
  let statusEl = null, draftEl = null, hintEl = null;
  let panel = null;
  let open = false;
  let onClosedCb = null;
  let tFn = (k) => k;
  let hfState = 'idle';
  let statusMsg = '';
  let micLevel = 0;
  let raf = 0;
  let stNow = '';

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
    overlay.querySelector('#convClose').addEventListener('click', () => closeInternal(false));
    document.addEventListener('keydown', (e) => {
      if (!open || e.key !== 'Escape') return;
      e.preventDefault();
      closeInternal(false);
    });
  }

  function loop(ts) {
    if (!open) return;
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
    const label = speaking ? tFn('conv_speaking') : statusMsg;
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
    hfState = 'idle';
    statusMsg = '';
    micLevel = 0;
    stNow = '';
    draftEl.textContent = '';
    open = true;
    overlay.hidden = false;
    requestAnimationFrame(() => overlay.classList.add('conv-in'));
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
      status: (m) => { statusMsg = m || ''; },
      statusHide: () => { statusMsg = ''; },
      toast: cfg.toast || (() => {}),
      t: tFn,
      onState: (s) => {
        hfState = s;
        if (s !== 'listening' && draftEl) draftEl.textContent = '';
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
    cancelAnimationFrame(raf);
    raf = 0;
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
    isOpen: () => open,
  };
})();
