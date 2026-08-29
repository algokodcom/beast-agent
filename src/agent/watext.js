'use strict';

/* WhatsApp metin yardımcıları: model çıktısının markdown süslerini
   temizleme + araç kullanımı için kısa durum satırları. Saf fonksiyonlar. */

/* Model çıktısını WhatsApp'a uygun sade metne çevir:
   **kalın**, *vurgu*, _italik_, #başlık, `kod`, [link](url), --- çizgiler temizlenir;
   liste maddeleri "• " olur; snake_case içindeki alt çizgi korunur. */
function waCleanText(md) {
  let t = String(md || '');
  /* #16: tüm markdown süsleri (bold/italik/başlık/işaret) düz metne iner */
  t = t.replace(/```[a-zA-Z0-9_-]*\r?\n?/g, '');
  t = t.replace(/`([^`\n]*)`/g, '$1');
  t = t.replace(/\*\*\*([^*\n]+)\*\*\*/g, '$1');
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '$1');
  t = t.replace(/^\s{0,3}#{1,6}\s*(.+)$/gm, '$1');
  /* satırbaşı liste işaretleri madde imine döner (kalın işareti değil) */
  t = t.replace(/^[ \t]*\*[ \t]+/gm, '\u2022 ');
  t = t.replace(/\*/g, '');
  t = t.replace(/^#{1,6}\s*/gm, '');
  t = t.replace(/#/g, '');
  t = t.replace(/(^|[\s(>])_([^_\n]+)_(?=$|[\s).,!?;:])/g, '$1$2');
  t = t.replace(/^\s*>+\s?/gm, '');
  t = t.replace(/^\s*[-+]\s+/gm, '\u2022 ');
  t = t.replace(/^[ \t]*[_\-=]{3,}[ \t]*\r?\n?/gm, '');
  t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)');
  t = t.replace(/[ \t]+$/gm, '');
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

/* Araç adı + argümanlardan tek satırlık durum metni — düz metin (#16: işaretsiz) */
const TOOL_LABELS = {
  run_command: (a) => `Terminal: ${String(a.command || '').replace(/\s+/g, ' ').trim().slice(0, 140)}`,
  read_file: (a) => `Dosya oku: ${a.path || ''}`,
  write_file: (a) => `Dosya yaz: ${a.path || ''}`,
  list_dir: (a) => `Klasör: ${a.path || '.'}`,
  web_search: (a) => `Web arama: ${String(a.query || '').slice(0, 100)}`,
  http_fetch: (a) => `Sayfa: ${a.url || ''}`,
  browser_open: (a) => `Tarayıcı aç: ${a.url || ''}`,
  browser_click: (a) => `Tıkla: ${a.ref ?? ''}`,
  browser_type: (a) => `Yaz: ${String(a.text || '').slice(0, 60)}`,
  browser_select: (a) => `Seç: ${a.ref ?? ''}`,
  browser_navigate: (a) => `Git: ${a.url || ''}`,
  browser_screenshot: () => 'Ekran görüntüsü',
  browser_snapshot: () => 'Sayfa yapısı',
  browser_read_text: () => 'Sayfa metni',
  email_list: () => 'E-posta listesi',
  email_read: (a) => `E-posta oku: ${a.uid ?? ''}`,
  email_send: () => 'E-posta gönder',
  memory_write: (a) => `Hafıza: ${String(a.text || '').slice(0, 60)}`,
  user_write: (a) => `Kullanıcı bilgisi: ${String(a.text || '').slice(0, 60)}`,
  memory_search: (a) => `Hafıza ara: ${String(a.query || '').slice(0, 60)}`,
  todo_write: (a) => `Görev listesi (${(a.todos || []).length})`,
  delegate_task: (a) => `Alt görev: ${String(a.task || '').slice(0, 80)}`,
  set_reminder: (a) => `Hatırlatma${a.repeat ? ' [' + a.repeat + ']' : ''}: ${String(a.message || '').slice(0, 60)}`,
  watcher_add: (a) => `İzleyici kur: ${a.name || ''}`,
  watcher_list: () => 'İzleyiciler',
  watcher_remove: (a) => `İzleyici sil: ${a.id || ''}`,
  event_subscribe: (a) => `Olay aboneliği: ${a.type || ''}`,
  event_list: () => 'Olay abonelikleri',
  event_unsubscribe: (a) => `Abonelik sil: ${a.id || ''}`,
  kb_add: (a) => `Bilgi ekle: ${String(a.title || '').slice(0, 60)}`,
  kb_search: (a) => `Bilgi ara: ${String(a.query || '').slice(0, 60)}`,
  memory_hygiene: () => 'Hafıza temizliği',
  computer_look: () => 'Ekranı görüntülüyor',
  computer_act: (a) => `Bilgisayar kullanıyor: ${a.op || ''}${a.combo ? ' ' + a.combo : ''}`,
};

function waToolLine(name, args) {
  const f = TOOL_LABELS[name];
  const body = f ? f(args || {}) : String(name);
  return `\u203A ${body}`;
}

module.exports = { waCleanText, waToolLine };
