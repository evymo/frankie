'use strict';
/** CSV → pole objektů. Hlavička v prvním řádku, oddělovač , ; nebo tab (autodetekce), uvozovky "". */

function detectDelimiter(line) {
  const counts = [',', ';', '\t'].map((d) => [d, line.split(d).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}

function parseLine(line, d) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
    } else if (c === '"') q = true;
    else if (c === d) { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function coerce(v) {
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d+[.,]\d+$/.test(v)) return parseFloat(v.replace(',', '.'));
  if (/^(true|false)$/i.test(v)) return v.toLowerCase() === 'true';
  if (v === '') return null;
  return v;
}

function csvToJson(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) throw new Error('CSV musí mít hlavičku a alespoň jeden řádek dat');
  const d = detectDelimiter(lines[0]);
  const header = parseLine(lines[0], d);
  if (header.some((h) => !h)) throw new Error('Prázdný název sloupce v hlavičce');
  return lines.slice(1).map((l, i) => {
    const cells = parseLine(l, d);
    if (cells.length !== header.length) throw new Error(`Řádek ${i + 2}: počet buněk ${cells.length} ≠ ${header.length}`);
    const o = {};
    header.forEach((h, j) => { o[h] = coerce(cells[j]); });
    return o;
  });
}

/** Najde CSV blok v textu: ```csv blok, nebo souvislé řádky se stejným počtem oddělovačů (≥2 řádky). */
function findCsvBlock(text) {
  const s = String(text || '');
  const fence = s.match(/```(?:csv)?\s*\n([\s\S]*?)```/i);
  if (fence && /[,;\t]/.test(fence[1])) return fence[1].trim();
  const lines = s.split(/\r?\n/);
  let best = [];
  let cur = [];
  let curD = null;
  let curN = -1;
  for (const raw of lines) {
    const l = raw.trim();
    const d = l ? detectDelimiter(l) : null;
    const n = d ? l.split(d).length - 1 : 0;
    if (l && n > 0 && (cur.length === 0 || (d === curD && n === curN))) {
      cur.push(l); curD = d; curN = n;
    } else {
      if (cur.length > best.length) best = cur;
      cur = l && n > 0 ? [l] : [];
      curD = d; curN = n;
    }
  }
  if (cur.length > best.length) best = cur;
  return best.length >= 2 ? best.join('\n') : null;
}

module.exports = { csvToJson, findCsvBlock };
