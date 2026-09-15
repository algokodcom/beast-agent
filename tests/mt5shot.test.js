'use strict';

require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const shot = require('../src/agent/defaulttools/mt5_shot/run.js');

test('mt5_shot: tek sembol + tek periyot → plan yok (tek çekim yolu)', () => {
  assert.deepEqual(shot.buildPlan({ symbol: 'GOLD', timeframe: 'M15' }), []);
});

test('mt5_shot: çoklu sembol → her sembolden bir kare', () => {
  const p = shot.buildPlan({ symbols: ['gold', 'EURUSD', 'BTCUSD', 'EURUSD'] });
  assert.deepEqual(p.map((x) => x.symbol), ['GOLD', 'EURUSD', 'BTCUSD']);
  assert.ok(p.every((x) => x.timeframe === null));
});

test('mt5_shot: symbols string + symbol birleşir, tekrarlar tekil', () => {
  assert.deepEqual(shot.normalizeSymbols({ symbol: 'GOLD', symbols: 'GOLD, EURUSD|BTCUSD' }), ['GOLD', 'EURUSD', 'BTCUSD']);
});

test('mt5_shot: symbols × timeframes ızgarası (sembol sırası korunur)', () => {
  const p = shot.buildPlan({ symbols: ['GOLD', 'EURUSD'], timeframes: ['M15', 'M5'] });
  assert.deepEqual(p, [
    { symbol: 'GOLD', timeframe: 'M15' },
    { symbol: 'GOLD', timeframe: 'M5' },
    { symbol: 'EURUSD', timeframe: 'M15' },
    { symbol: 'EURUSD', timeframe: 'M5' },
  ]);
});

test('mt5_shot: tek sembol + timeframes → eski çoklu periyot davranışı', () => {
  const p = shot.buildPlan({ symbol: 'GOLD', timeframes: ['M1', 'M15'] });
  assert.deepEqual(p, [
    { symbol: 'GOLD', timeframe: 'M1' },
    { symbol: 'GOLD', timeframe: 'M15' },
  ]);
});

test('mt5_shot: tf2 kısayolu → aktif grafik çoklu periyot planı', () => {
  const p = shot.buildPlan({ timeframe: 'M1', tf2: 'M15' });
  assert.deepEqual(p.map((x) => x.timeframe), ['M1', 'M15']);
  assert.ok(p.every((x) => x.symbol === null));
});

test('mt5_shot: panel tavanı 6 (watchdog bütçesi)', () => {
  const p = shot.buildPlan({ symbols: ['A', 'B', 'C'], timeframes: ['M1', 'M5', 'M15'] });
  assert.equal(p.length, 6);
  assert.deepEqual(p[5], { symbol: 'B', timeframe: 'M15' });
});

test('mt5_shot: sanitizeFile uzantı ekler ve yol kaçışını engeller', () => {
  assert.equal(shot.sanitizeFile('../../x/y', 'beast_shot_x.png'), 'y.png');
  assert.equal(shot.sanitizeFile('foo', 'f.png'), 'foo.png');
});

/* UÇTAN UCA: sahte EA (v1.22 davranışı) ack'i HEMEN yazar, PNG'yi hemen
   üretir; tool ack'i alıp PNG'yi bekler ve ok:true döner. Bu akış, "EA
   komutu alıyor ama ack/PNG gelmiyor" sınıfı hatanın regresyon testidir. */
test('mt5_shot: uçtan uca — EA ack yazar, PNG üretilir, ok:true döner', async () => {
  const toolDir = path.join(__dirname, '..', 'src', 'agent', 'defaulttools', 'mt5_shot');
  const fileName = 'e2e_test_' + Date.now().toString(36) + '.png';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beast-shot-e2e-'));
  const fakeAppData = path.join(tmp, 'appdata');
  const filesDir = path.join(fakeAppData, 'MetaQuotes', 'Terminal', 'FAKEHASH', 'MQL5', 'Files');
  fs.mkdirSync(filesDir, { recursive: true });
  const beatF = path.join(filesDir, 'beast_ea.json');
  const cmdF = path.join(filesDir, 'beast_cmd.json');
  const ackF = path.join(filesDir, 'beast_cmd_ack.json');
  fs.writeFileSync(beatF, JSON.stringify({ ok: true, ea: 'BeastFinance', version: '1.22' }));

  const fakeEa = spawn(
    process.execPath,
    [
      '-e',
      `
      const fs=require('fs'), path=require('path');
      const dir=${JSON.stringify(filesDir)}, cmd=${JSON.stringify(cmdF)}, ack=${JSON.stringify(ackF)}, beat=${JSON.stringify(beatF)};
      setInterval(()=>{
        try{
          fs.writeFileSync(beat, JSON.stringify({ok:true,stage:'beat'}));
          if(!fs.existsSync(cmd)) return;
          const buf=fs.readFileSync(cmd);
          const raw=(buf[0]===0xFF&&buf[1]===0xFE?buf.slice(2).toString('utf16le'):buf.toString('utf8')).replace(/^\\uFEFF/,'').replace(/\\0/g,'');
          const j=JSON.parse(raw);
          const file=(j.params&&j.params.file)||'beast_shot.png';
          fs.writeFileSync(ack, JSON.stringify({ok:true,id:j.id,cmd:'shot',result:{file,symbol:'GOLD',period:16385}}));
          const png=Buffer.alloc(2200);
          Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]).copy(png,0);
          fs.writeFileSync(path.join(dir,file), png);
          fs.unlinkSync(cmd);
        }catch(e){}
      }, 120);
      `,
    ],
    { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true }
  );

  try {
    const outdir = path.join(tmp, 'out');
    const child = spawn(process.execPath, [path.join(toolDir, 'run.js')], {
      env: { ...process.env, APPDATA: fakeAppData, BEAST_TOOL_DIAG: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.stdin.end(JSON.stringify({ file: fileName, outdir, timeoutSec: 8, embed: false }));
    await new Promise((r) => child.on('close', r));
    const line = out.trim().split('\n').filter(Boolean).pop() || '';
    const res = JSON.parse(line || '{}');
    assert.equal(res.ok, true, 'sonuç ok olmalı — stderr: ' + err.slice(0, 200));
    assert.equal(res.file, fileName);
    assert.ok(res.bytes > 1500, 'PNG üretilmeli');
    assert.ok(fs.existsSync(path.join(outdir, fileName)), 'PNG kullanıcı klasörüne kopyalanmalı');
    assert.equal(res.symbol, 'GOLD');
  } finally {
    try { fakeEa.kill(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    /* kaynak ağacından koşulunca oluşan çalışma zamanı artıkları temizlenir */
    try { fs.rmSync(path.join(toolDir, 'shots', fileName), { force: true }); } catch {}
    try { fs.rmSync(path.join(toolDir, '.shot.lock'), { force: true }); } catch {}
    try { fs.rmSync(path.join(toolDir, 'last-args.json'), { force: true }); } catch {}
  }
});
