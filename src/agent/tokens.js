'use strict';

/* Beast tokens: dependency-free token estimation for context budgeting.
   Accuracy is calibrated at runtime with real usage.prompt_tokens values
   fed back from the API (see Engine.tokRatio). */

function estTokens(text) {
  const s = String(text || '');
  if (!s) return 0;
  let narrow = 0;
  let wide = 0;
  for (let i = 0; i < s.length; i++) {
    // CJK ve emoji gibi geniş karakterler token başına daha fazla maliyetlidir
    if (s.charCodeAt(i) > 0x2e7f) wide++;
    else narrow++;
  }
  return Math.ceil((narrow + wide * 2.5) / 4);
}

function estMsgTokens(m) {
  if (!m) return 0;
  let t = 4; // mesaj zarfı (role vb.)
  const content = m.content;
  if (typeof content === 'string') {
    t += estTokens(content);
  } else if (Array.isArray(content)) {
    for (const p of content) {
      if (p && p.type === 'text') t += estTokens(p.text);
      else if (p && p.type === 'image_url') t += 600; // düşük detaylı görsel yaklaşımı
      else t += estTokens(JSON.stringify(p || ''));
    }
  }
  if (m.tool_calls && m.tool_calls.length) {
    t += estTokens(JSON.stringify(m.tool_calls)) + 3 * m.tool_calls.length;
  }
  return t;
}

module.exports = { estTokens, estMsgTokens };
