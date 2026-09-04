'use strict';

/* Kurulum progress bus — agent modülleri (whisper / mem0 / tools) yüzde üretir,
   main abone olup renderer'a 'install-progress' agent:event olarak aktarır.
   transformers.js progress_callback'i dosya bazlı geldiği için per-dosya
   loaded/total toplamından genel yüzde hesaplayan aggregator da burada. */

const listeners = new Set();

function onInstallProgress(fn) {
  if (typeof fn === 'function') listeners.add(fn);
  return () => listeners.delete(fn);
}

function emitInstallProgress(id, data) {
  for (const fn of listeners) {
    try { fn(id, data); } catch {}
  }
}

/* transformers.js benzeri dosya bazlı akışlar için: per-dosya loaded/total'dan
   genel yüzde üreten progress_callback üretir. */
function fileProgressAggregator(id) {
  const files = new Map(); // file -> { loaded, total }
  return (d) => {
    try {
      const key = d && (d.file || d.name);
      if (!key || typeof d.loaded !== 'number' || typeof d.total !== 'number' || d.total <= 0) return;
      files.set(String(key), { loaded: d.loaded, total: d.total });
      let loaded = 0;
      let total = 0;
      for (const v of files.values()) {
        loaded += v.loaded;
        total += v.total;
      }
      if (total > 0) emitInstallProgress(id, { pct: (loaded / total) * 100, loaded, total });
    } catch {}
  };
}

module.exports = { onInstallProgress, emitInstallProgress, fileProgressAggregator };
