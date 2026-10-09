'use strict';
/** Deterministické statistiky textu. */

function words(text) {
  return String(text || '').match(/[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu) || [];
}

function sentences(text) {
  return String(text || '').split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => /[\p{L}\p{N}]/u.test(s));
}

function textStats(text) {
  const w = words(text);
  const freq = {};
  for (const x of w) {
    const k = x.toLowerCase();
    if (k.length < 4) continue;
    freq[k] = (freq[k] || 0) + 1;
  }
  const top = Object.entries(freq).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5)
    .map(([word, count]) => ({ word, count }));
  return { words: w.length, sentences: sentences(text).length, characters: String(text || '').length, topWords: top };
}

module.exports = { words, sentences, textStats };
