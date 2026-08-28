'use strict';

/* Beast PDF yardımcısı: pdf-parse v2 ile düz metin çıkarımı.
   pdf-parse kendi pdfjs-dist@5.4.296 kopyasını kullanır (nested). Aynı process'te
   başka bir pdfjs sürümü yükleyen paket (örn. pdf-to-img) açılırsa globalThis
   worker cache çakışmasından "API version ... does not match Worker version"
   hatası çıkar — o yüzden render/OCR işleri AYRI node süreçlerinde yapılır
   (ayrıntı: pdf skill'i). */

async function extract(buf) {
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    return await parser.getText();
  } finally {
    await parser.destroy();
  }
}

module.exports = { extract };
