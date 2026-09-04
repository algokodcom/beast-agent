'use strict';

/* Beast ELLER SERBEST konuşma — Hermes agent'ın browser ses döngüsü portu.
   Kaynak: hermes-agent-main/apps/desktop/src/app/chat/composer/hooks/use-mic-recorder.ts,
   use-voice-conversation.ts, lib/voice-barge-in.ts, lib/voice-stop-word.ts.

   Döngü: dinle → konuşurken kelimeler CANLI önizlenir (kısmi transkript) → susunca
   cümle kesilir → son transkript OTOMATİK GÖNDERİLİR → LLM yazarken mikrofon CANLI
   KALIR (barge-in): konuşursan çalışan tur kesilir, sözün sıradaki tur olur.

   Gürültü reddi: 800ms zemin kalibrasyonu, tetik = zemin×4.5 (tavan 0.37),
   ~350ms pencerede %85 çoğunluk — TV/klavye gürültüleri geçmez.
   Tık = modu ANINDA aç/kapat. "dur/yeter/goodbye" sözlü stop.
   VAD: 0.10 eşik, 1250ms sessizlik = cümle sonu, 12s boş hava,
   90s tur tavanı, üst üste 3 boş tur = modu kapat. */

(function () {
  /* ---------- stop komutları (voice-stop-word.ts portu + Türkçe set) ---------- */

  const STOP_PHRASES = [
    'stop', 'stop listening', 'stop it', 'stop please', 'please stop', 'stop stop',
    'that is all', "that's all", 'never mind', 'nevermind',
    'end conversation', 'end the conversation', 'goodbye', 'good bye', 'bye', 'cancel',
    // Türkçe stop komutları — yalnızca TÜM cümle bu ise eşleşir
    'dur', 'durur', 'dur dinleme', 'dinlemeyi durdur', 'yeter', 'yeterli',
    'boş ver', 'bos ver', 'iptal', 'iptal et', 'görüşürüz', 'gorusuruz',
    'bay bay', 'hoşça kal', 'hosca kal', 'kapat', 'kapat konuşmayı', 'sus',
  ];
  const ADDRESS_PREFIXES = ['hey beast', 'beast', 'eyvah', 'ok', 'okay', 'hey', 'hadi'];

  function normalize(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[.,!?;:…]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function stripAddress(text) {
    for (const prefix of ADDRESS_PREFIXES) {
      if (text === prefix) continue; // tek başına hitap stop değildir
      if (text.startsWith(prefix + ' ')) return text.slice(prefix.length + 1).trim();
    }
    return text;
  }

  /** TÜM söylevin stop komutu olduğunda true — "durdur konteyneri" yutulmaz. */
  function isVoiceStopCommand(transcript) {
    const normalized = normalize(transcript);
    if (!normalized) return false;
    const candidates = new Set([normalized, stripAddress(normalized)]);
    for (const c of candidates) if (STOP_PHRASES.includes(c)) return true;
    return false;
  }

  /* ---------- mikrofon kaydedici (use-mic-recorder.ts + barge-in portu) ---------- */

  const MAX_RECORD_MS = 120000; // voice.max_recording_seconds (Hermes)
  const TRIGGER_CEILING = 0.37; // ≈ int16 RMS 4000 (Hermes TRIGGER_CEILING)
  const SUSTAINED_WIN = 22; // ~350ms rAF penceresi
  const SUSTAINED_MAJORITY = 0.85; // %85 çoğunluk — tek kare gürültü asla geçmez

  function percentile90(arr) {
    if (!arr.length) return 0.02;
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
  }

  function createMicRecorder() {
    let recorder = null;
    let stream = null;
    let chunks = [];
    let audioCtx = null;
    let rafId = null;
    let startedAt = 0;
    let heardSpeech = false;
    let triggered = false;
    let silenceTriggered = false;
    let silenceStartedAt = null;
    let stopResolver = null;
    let stopWaiters = [];

    const resolveWaiters = (v) => {
      const w = stopWaiters;
      stopWaiters = [];
      for (const f of w) { try { f(v); } catch {} }
    };

    const cleanup = () => {
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
      try { if (audioCtx) audioCtx.close(); } catch {}
      audioCtx = null;
      try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch {}
      stream = null;
      recorder = null;
      silenceTriggered = false;
    };

    function startMeter(micStream, options) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return;
      try {
        audioCtx = new Ctor();
        if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        const src = audioCtx.createMediaStreamSource(micStream);
        src.connect(analyser);
        const data = new Uint8Array(analyser.fftSize);
        const quiet = []; // (artık kullanılmıyor — EMA zemin var)
        const aboveWin = []; // konuşma penceresi
        const trgBuf = []; // barge kesme kararı penceresi (daha uzun, daha sıkı)
        const ttsWin = []; // TTS sızıntı zemini (son ~1sn)
        let floor = -1; // EMA gürültü zemini (openclaw)
        let trigger = options.silenceLevel || 0;
        const tick = () => {
          analyser.getByteTimeDomainData(data);
          let sum = 0;
          for (const v of data) { const c = v - 128; sum += c * c; }
          const rms = Math.sqrt(sum / data.length);
          const normalized = Math.min(1, rms / 42); // Hermes: rms/42 normalize
          const now = Date.now();
          if (options.onLevel) options.onLevel(normalized);

          const speechThreshold = options.silenceLevel || 0;
          const silenceMs = options.silenceMs || 0;
          const idleSilenceMs = options.idleSilenceMs || 0;

          if (speechThreshold > 0 && options.onSilence && !silenceTriggered) {
            /* EMA zemin (openclaw noteAudioLevel birebir):
               sessizken hızlı düşer (α 0.08), sesliyken çok yavaş yükselir (α 0.01)
               — sürekli uyarlanır, kalibrasyon penceresi gerekmez */
            if (floor < 0) floor = Math.max(normalized, 0.03);
            if (normalized < floor) floor += (normalized - floor) * 0.08;
            else floor += (normalized - floor) * 0.01;

            /* tetik = zemin × 6.0 (openclaw speechBoostFactor), konuşma alt sınırı ile */
            trigger = Math.max(speechThreshold, Math.min(TRIGGER_CEILING, floor * 6.0));

            /* TTS çalarken: hoparlör sızıntısı ayrı hızlı zemin — tetik sızıntı × 2.2;
               kullanıcı sesi sızıntıyı ezerse keser (doğal konuşma) */
            if (ttsState.playing) {
              ttsWin.push(normalized);
              if (ttsWin.length > 12) ttsWin.shift();
              trigger = Math.max(BARGE_MIN_TRIGGER, Math.min(0.5, percentile90(ttsWin) * 2.2));
            }

            /* grace: submit sonrası kısa süre konuşma tetiklenmez (zemin yine güncellenir) */
            const inGrace = now - startedAt < (options.graceMs || 0);

            const isAbove = normalized >= trigger;
            aboveWin.push(isAbove);
            if (aboveWin.length > SUSTAINED_WIN) aboveWin.shift();
            const majority =
              aboveWin.length >= SUSTAINED_WIN &&
              aboveWin.filter(Boolean).length >= Math.ceil(SUSTAINED_WIN * SUSTAINED_MAJORITY);

            if (majority && !inGrace) heardSpeech = true;
            if (isAbove) silenceStartedAt = null;

            /* barge kesme kararı: daha uzun pencere + çoğunluk */
            if (options.onTrigger && !triggered && !inGrace) {
              const trgWin = Math.max(SUSTAINED_WIN, options.triggerWinFrames || SUSTAINED_WIN);
              trgBuf.push(isAbove);
              if (trgBuf.length > trgWin) trgBuf.shift();
              const trgMajority =
                trgBuf.length >= trgWin &&
                trgBuf.filter(Boolean).length >= Math.ceil(trgWin * SUSTAINED_MAJORITY);
              if (trgMajority) {
                triggered = true;
                options.onTrigger();
              }
            }

            /* cümle sonu: konuşma bitince sessizlik süresi */
            if (heardSpeech && silenceMs > 0) {
              if (silenceStartedAt == null) silenceStartedAt = now;
              if (now - silenceStartedAt >= silenceMs) {
                silenceTriggered = true;
                options.onSilence();
                return;
              }
            } else if (!heardSpeech && idleSilenceMs > 0 && now - startedAt >= idleSilenceMs) {
              silenceTriggered = true; // boş hava: hiç konuşulmadan timeout
              options.onSilence();
              return;
            }
          }
          if (now - startedAt >= MAX_RECORD_MS && !silenceTriggered) {
            silenceTriggered = true;
            options.onSilence();
            return;
          }
          rafId = requestAnimationFrame(tick);
        };
        tick();
      } catch {}
    }

    function micError(error) {
      const name = error instanceof DOMException ? error.name : '';
      if (name === 'NotAllowedError' || name === 'SecurityError') return new Error('denied');
      if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return new Error('no-mic');
      if (name === 'NotReadableError' || name === 'TrackStartError') return new Error('in-use');
      return error instanceof Error ? error : new Error('start-failed');
    }

    async function start(options) {
      if (recorder) return;
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') {
        throw new Error('unsupported');
      }
      let micStream;
      try {
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch (e) {
        throw micError(e);
      }
      const mimeType =
        ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg', 'audio/wav'].find(
          (t) => MediaRecorder.isTypeSupported(t)
        ) || '';
      let rec;
      try {
        rec = new MediaRecorder(micStream, mimeType ? { mimeType } : undefined);
      } catch (e) {
        try { micStream.getTracks().forEach((t) => t.stop()); } catch {}
        throw micError(e);
      }
      chunks = [];
      stream = micStream;
      recorder = rec;
      heardSpeech = false;
      triggered = false;
      silenceTriggered = false;
      silenceStartedAt = null;
      startedAt = Date.now();      rec.ondataavailable = (ev) => { if (ev.data && ev.data.size > 0) chunks.push(ev.data); };
      rec.onstop = () => {
        const out = chunks;
        const type = rec.mimeType || mimeType || 'audio/webm';
        const durationMs = Date.now() - startedAt;
        const spoken = heardSpeech;
        chunks = [];
        cleanup();
        const resolve = stopResolver;
        stopResolver = null;
        if (resolve) resolve(out.length ? { audio: new Blob(out, { type }), durationMs, heardSpeech: spoken } : null);
      };
      rec.onerror = (ev) => {
        const err = micError(ev && ev.error);
        const resolve = stopResolver;
        stopResolver = null;
        cleanup();
        if (options && options.onError) options.onError(err);
        if (resolve) resolve(null);
      };
      rec.start();
      startMeter(micStream, options);
    }

    function stop() {
      return new Promise((resolve) => {
        const rec = recorder;
        if (!rec || rec.state === 'inactive') { cleanup(); resolve(null); return; }
        stopResolver = resolve;
        rec.stop();
      });
    }

    /* stop'un BİRİÇİK yolunu bekle: onSilence stop'u, cancel veya hata */
    function waitStop() {
      if (!recorder) return Promise.resolve(null);
      return new Promise((res) => { stopWaiters.push(res); });
    }

    function cancel() {
      const rec = recorder;
      const resolve = stopResolver;
      stopResolver = null;
      if (rec && rec.state !== 'inactive') {
        rec.ondataavailable = null;
        rec.onerror = null;
        rec.onstop = null;
        try { rec.stop(); } catch {}
      }
      cleanup();
      resolveWaiters(null);
      if (resolve) resolve(null);
    }

    /* kısmi transkript önizleme için şu ana kadarki ham blob */
    function partialBlob() {
      if (!chunks.length || !recorder) return null;
      const type = (recorder.mimeType || 'audio/webm').split(';')[0];
      return new Blob(chunks, { type });
    }

    return { start, stop, cancel, waitStop, partialBlob };
  }

  /* ---------- panel döngüsü (use-voice-conversation.ts portu) ---------- */

  const SILENCE_LEVEL = 0.10; // konuşma eşiği alt sınırı — TV/gürültü zemini geçmesin
  const BARGE_MIN_TRIGGER = 0.17; // barge kesme eşiği — daha katı
  const SILENCE_MS = 700; // openclaw: 700ms sessizlik = cümle sonu (hızlı tur)
  const IDLE_SILENCE_MS = 12000; // boş hava timeout
  const TURN_TIMEOUT_MS = 90000; // tek dinleme turu tavanı
  const NO_SPEECH_LIMIT = 3; // üst üste 3 boş tur → modu kapat (Hermes)
  const REPLY_WAIT_MS = 300000; // cevap bekleme tavanı
  const DRIVE_MS = 500; // döngü kalp atışı
  const PARTIAL_MS = 2500; // canlı önizleme aralığı

  /* Tek mikrofon politikası: bir panel eller-serbeste girince diğeri kapanır */
  let activePanel = null;

  /* TTS YANKI KÖPRÜSÜ — renderer.js doldurur */
  const ttsState = { lastText: '', playing: false, lastEndedAt: 0 };

  /* transkript, az önce SESLENDİRİLEN metnin yankısı mı? (Hermes is_tts_echo)
     kelime örtüşmesi ≥%65 veya birbiri içinde geçme → yankı say.
     TTS az bittiysen (2sn) eşik %40'a düşer — kalıntı daha agresif atılır. */
  function echoLikely(transcript) {
    const spoken = normalize(ttsState.lastText || '');
    if (!spoken || spoken.length < 8) return false;
    const t = normalize(transcript || '');
    if (!t || t.length < 4) return false;
    if (spoken.includes(t) || t.includes(spoken)) return true;
    const toks = (s) => s.split(/\s+/).filter((w) => w.length > 2);
    const a = toks(t);
    const b = new Set(toks(spoken));
    if (!a.length || !b.size) return false;
    let hit = 0;
    for (const w of a) if (b.has(w)) hit++;
    const ratio = hit / a.length;
    return ratio >= (Date.now() - (ttsState.lastEndedAt || 0) < 2000 ? 0.4 : 0.65);
  }

  function blobToDataUrl(b) {
    return new Promise((res) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.readAsDataURL(b);
    });
  }

  /**
   * createPanel({ btn, isBusy, submit, transcribe, draft, interrupt, cutTts, status, statusHide, toast, t })
   */
  function createPanel(opts) {
    const { btn, isBusy, submit, transcribe, toast } = opts;
    const t = opts.t || ((k) => k);
    const showDraft = opts.draft || (() => {});
    const doInterrupt = opts.interrupt || (() => {});
    const cutTts = opts.cutTts || (() => {});
    const showStatus = opts.status || ((m) => toast(m));
    const hideStatus = opts.statusHide || (() => {});

    const recorder = createMicRecorder();
    let state = 'idle'; // idle | listening | transcribing | thinking
    let active = false; // eller-serbest modu AÇIK mı
    let pendingStart = false;
    let turnClosing = false;
    let turnTimeout = null;
    let partialTimer = null;
    let partialBusy = false;
    let partialSize = 0;
    let partialCount = 0; // tur başına önizleme bütçesi (CPU koruması)
    let sttLatencyMs = 0; // son transkript süresi — yavaşsa önizlemeler kapanır
    let driveTimer = null;
    let noSpeechStrikes = 0;

    /* STT süresini ölç: turbo CPU'da yavaşsa canlı önizleme LÜKS kapanır,
       final transkript hızlanır (birikme biter) */
    const timedTranscribe = async (blob, isStale, priority) => {
      const t0 = Date.now();
      try {
        return await transcribe(blob, isStale, priority);
      } finally {
        sttLatencyMs = Date.now() - t0;
      }
    };

    const setState = (s) => {
      state = s;
      btn.classList.toggle('rec', s === 'listening');
      btn.classList.toggle('hf', active && s !== 'listening');
    };

    const clearTurnTimeout = () => {
      if (turnTimeout) { clearTimeout(turnTimeout); turnTimeout = null; }
    };

    const stopPartial = () => {
      if (partialTimer) { clearInterval(partialTimer); partialTimer = null; }
      partialBusy = false;
      partialSize = 0;
    };

    /* konuşurken kelimeleri canlı göster; TTS çalarken kayıtta TTS sesi de
       olduğu için önizleme atlanır (transkript çöp olur) */
    const startPartial = () => {
      stopPartial();
      if (!opts.draft) return;
      partialCount = 0;
      sttLatencyMs = 0; // yeni tur — bir kez ölçüp karar ver
      partialTimer = setInterval(async () => {
        if (partialBusy || state !== 'listening' || !active) return;
        if (ttsState.playing) return;
        /* ADAPTİF: son transkript 3.5 sn'den uzun sürdüyse (turbo CPU'da yavaş)
           önizlemeler kapanır — final hızlanır, kuyruk birikmez */
        if (sttLatencyMs > 3500) return;
        const blob = recorder.partialBlob();
        if (!blob || blob.size <= partialSize + 4000) return; // yeni ses yoksa atla
        partialBusy = true;
        partialCount++;
        try {
          const text = String(
            (await timedTranscribe(blob, () => state !== 'listening', 0)) || ''
          ).trim();
          partialSize = blob.size;
          if (text && active && state === 'listening' && !echoLikely(text)) showDraft(text);
        } catch {} finally {
          partialBusy = false;
        }
      }, PARTIAL_MS);
    };

    const rearm = () => {
      setState('idle');
      hideStatus();
      pendingStart = true; // drive() mikrofonu yeniden açar
    };

    const end = (silent) => {
      active = false;
      pendingStart = false;
      turnClosing = false;
      noSpeechStrikes = 0;
      clearTurnTimeout();
      stopPartial();
      recorder.cancel();
      if (activePanel === panel) activePanel = null;
      setState('idle');
      hideStatus();
      if (!silent) toast(t('hf_stopped'));
    };

    async function waitReplyDone() {
      const t0 = Date.now();
      while (Date.now() - t0 < REPLY_WAIT_MS) {
        await new Promise((r) => setTimeout(r, 250));
        if (!isBusy()) return;
      }
    }

    /* transkript ortak yolu: döner 'closed' | 'echo' | 'empty' | 'submitted' */
    async function utteranceTurn(audio) {
      let transcript = '';
      try {
        /* final transkript ÖNCELİKLİ (1) — önizlemelerin önüne geçer */
        transcript = String((await timedTranscribe(audio, null, 1)) || '').trim();
      } catch {
        transcript = '';
      }
      if (!active) return 'closed';
      /* TTS yankısı — ajanın kendi sesi; asla tur yapılmaz */
      if (transcript && echoLikely(transcript)) return 'echo';
      if (!transcript || transcript.replace(/\s/g, '').length < 2) {
        noSpeechStrikes++;
        if (noSpeechStrikes >= NO_SPEECH_LIMIT) { end(true); toast(t('hf_stopped')); return 'closed'; }
        return 'empty';
      }
      if (isVoiceStopCommand(transcript)) {
        end(true);
        toast(t('hf_stopped'));
        return 'closed';
      }
      noSpeechStrikes = 0;
      setState('thinking');
      showStatus(t('hf_thinking'));
      await submit(transcript);
      return 'submitted';
    }

    async function handleTurn() {
      if (turnClosing || !active) return;
      turnClosing = true;
      clearTurnTimeout();
      setState('transcribing');
      showStatus(t('mic_transcribing'));
      try {
        const result = await recorder.stop();
        if (!active) return;
        stopPartial();
        /* hayalet koruması: <1sn segment (gürültü/pik) asla tur yapılmaz */
        if (!result || !result.heardSpeech || (result.durationMs && result.durationMs < 1000)) {
          noSpeechStrikes++;
          if (noSpeechStrikes >= NO_SPEECH_LIMIT) { end(true); return; }
          rearm();
          return;
        }
        const outcome = await utteranceTurn(result.audio);
        if (outcome === 'closed' || !active) return;
        if (outcome === 'echo') { rearm(); return; } // yankı — sessizce yeniden dinle
        await thinkingPhase();
      } finally {
        turnClosing = false;
      }
    }

    /* BARGE-IN: LLM yazarken mikrofon CANLI — adaptif sızıntı zemini ile.
       Kullanıcı sesi sızıntıyı ezerse: TTS kesilir + konuşma yakalanır. */
    async function thinkingPhase() {
      while (active) {
        let triggered = false;
        let monitorRes = null;
        const doneP = waitReplyDone();
        const monP = (async () => {
          await recorder.start({
            silenceLevel: BARGE_MIN_TRIGGER,
            silenceMs: SILENCE_MS,
            idleSilenceMs: IDLE_SILENCE_MS,
            triggerWinFrames: 30, // ~500ms pencerede %85 çoğunluk — TV kesintisi zor
            onTrigger: () => {
              triggered = true;
              doInterrupt(); // çalışan turu kes — Stop düğmesiyle aynı kanal
              cutTts(); // TTS ANINDA kesilir
              startPartial();
            },
            onSilence: () => { recorder.stop().catch(() => {}); },
            onError: () => { recorder.cancel(); },
          });
          const r = await recorder.waitStop();
          stopPartial();
          return r;
        })();
        const first = await Promise.race([
          doneP.then(() => 'done'),
          monP.then((r) => { monitorRes = r; return 'mon'; }),
        ]);
        if (!active) return;
        if (first === 'done' && !triggered) {
          recorder.cancel();
          rearm();
          return;
        }
        if (monitorRes === null) monitorRes = await monP.catch(() => null);
        if (!active) return;
        if (!monitorRes || (!monitorRes.heardSpeech && !triggered)) {
          if (!isBusy()) { rearm(); return; }
          continue;
        }
        const outcome = await utteranceTurn(monitorRes.audio);
        if (outcome === 'closed' || !active) return;
        if (outcome === 'echo') { if (!isBusy()) { rearm(); return; } continue; }
        /* 'submitted' → döngü yeni izleme turu açar (LLM yeniden yazıyor) */
      }
    }

    async function startListening() {
      pendingStart = false;
      if (!active || isBusy() || state !== 'idle') return;
      try {
        await recorder.start({
          silenceLevel: SILENCE_LEVEL,
          silenceMs: SILENCE_MS,
          idleSilenceMs: IDLE_SILENCE_MS,
          onError: () => {
            pendingStart = false;
            end(true);
            toast(t('mic_denied'));
          },
          onSilence: () => { void handleTurn(); },
        });
        setState('listening');
        showStatus(t('hf_listening'));
        startPartial();
        clearTurnTimeout();
        turnTimeout = setTimeout(() => { void handleTurn(); }, TURN_TIMEOUT_MS);
      } catch {
        pendingStart = false;
        setState('idle');
        end(true);
        toast(t('mic_denied'));
      }
    }

    /* kalp atışı: panel serbest kalınca mikrofonu yeniden açar */
    driveTimer = setInterval(() => {
      if (active && pendingStart && state === 'idle' && !isBusy()) void startListening();
    }, DRIVE_MS);

    async function start() {
      if (activePanel && activePanel !== panel) activePanel.end(true); // tek mikrofon
      activePanel = panel;
      active = true;
      noSpeechStrikes = 0;
      pendingStart = true;
      toast(t('hf_start'));
      await startListening();
    }

    /* TIK = ANINDA AÇ/KAPAT */
    btn.addEventListener('click', () => {
      if (!active) { void start(); return; }
      end();
    });

    const panel = { end, get state() { return state; }, get active() { return active; } };
    return panel;
  }

  window.BeastHandsFree = { createPanel, isVoiceStopCommand, createMicRecorder, ttsState };
})();
