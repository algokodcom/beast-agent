'use strict';

/* Hesap Makinesi — Beast App örneği.
   Ajan için güvenli hesaplama aracı kaydeder; UI'daki geçmiş app storage'da yaşar. */

module.exports = (beast) => {
  const SAFE_RE = /^[\s+\-*/().,%0-9e]*$/i;

  function calc(expr) {
    const cleaned = String(expr || '').replace(/,/g, '.').trim();
    if (!cleaned) return { ok: false, error: 'ifade boş' };
    if (!SAFE_RE.test(cleaned.replace(/e[+-]?\d+/gi, 'N'))) {
      return { ok: false, error: 'yalnızca sayılar ve + - * / ( ) % , e işlemlerine izin var' };
    }
    try {
      const val = Function('"use strict"; return (' + cleaned + ')')();
      if (typeof val !== 'number' || !isFinite(val)) return { ok: false, error: 'sonuç sayı değil' };
      return { ok: true, expression: cleaned, result: val };
    } catch (e) {
      return { ok: false, error: 'geçersiz ifade: ' + String((e && e.message) || e).slice(0, 120) };
    }
  }

  beast.tools.register('hesapla', {
    description: 'Güvenli matematik hesaplayıcı. Örnek: "(1200*1.2)/3". Sadece sayılar ve + - * / ( ) % e desteklenir.',
    parameters: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'Hesaplanacak matematiksel ifade' },
      },
      required: ['expression'],
    },
    handler: (args) => calc(args.expression),
  });

  /* Geçmişi yükle (UI ile aynı storage'ı paylaşır) */
  const history = beast.storage.get('history', []);
  beast.log(`hazır — geçmişte ${history.length} hesap var`);

  beast.notify('Hesap Makinesi hazır — araç: app__hesap-makinesi__hesapla');
};
