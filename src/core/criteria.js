'use strict';
/**
 * Akceptační kritéria: validace návrhů (z auditu) a deterministické kontroly.
 * Neplatná deterministická kontrola se NEzahodí — převede se na sémantickou a eviduje se proč.
 */
const { CHECK_TYPES } = require('./schemas');
const { validate } = require('./schema');
const { extractJson, deepEqual, canonicalJson, truncate, normalizeForMatch } = require('./util');
const { words } = require('../tools/textStats');
const { runFunctionTests } = require('../tools/jsSandbox');

function paramProblem(type, p = {}) {
  switch (type) {
    case 'contains': case 'not_contains':
      return typeof p.text === 'string' && p.text.trim() ? null : 'chybí params.text';
    case 'regex':
      if (typeof p.pattern !== 'string' || !p.pattern || p.pattern.length > 200) return 'neplatný params.pattern';
      try { new RegExp(p.pattern, typeof p.flags === 'string' ? p.flags.replace(/[^imsu]/g, '') : 'i'); return null; } catch (e) { return 'regex nelze zkompilovat'; }
    case 'number_equals':
      return Number.isFinite(p.expected) ? null : 'params.expected musí být číslo';
    case 'max_words': case 'min_words':
      return Number.isInteger(p.n) && p.n > 0 ? null : 'params.n musí být kladné celé číslo';
    case 'json_schema':
      return p.schema && typeof p.schema === 'object' ? null : 'chybí params.schema';
    case 'json_equals':
      return 'expected' in p ? null : 'chybí params.expected';
    case 'js_function_tests':
      if (!/^[A-Za-z_$][\w$]*$/.test(String(p.functionName || ''))) return 'neplatný params.functionName';
      if (!Array.isArray(p.cases) || !p.cases.length || p.cases.length > 50) return 'params.cases musí mít 1–50 případů';
      return p.cases.every((c) => c && Array.isArray(c.args) && 'expected' in c) ? null : 'každý případ potřebuje args[] a expected';
    default:
      return null;
  }
}

function normalizeCriterion(proposal, id, origin) {
  const type = proposal.check && proposal.check.type;
  const params = (proposal.check && proposal.check.params) || {};
  let verification;
  let downgraded = null;
  if (!CHECK_TYPES.includes(type)) { verification = { kind: 'semantic', type: 'semantic', params: {} }; downgraded = `neznámý typ kontroly „${type}“`; }
  else if (type === 'semantic') verification = { kind: 'semantic', type: 'semantic', params: {} };
  else {
    const prob = paramProblem(type, params);
    if (prob) { verification = { kind: 'semantic', type: 'semantic', params: {} }; downgraded = `${type}: ${prob}`; }
    else verification = { kind: 'deterministic', type, params };
  }
  return { id, description: proposal.description, mandatory: proposal.mandatory !== false, verification, origin, ...(downgraded ? { downgraded } : {}) };
}

/** Systémová kritéria přidávaná algoritmem ke každému kontraktu. */
function systemCriteria(expectedFormat, blockedOperations = []) {
  const list = [
    { id: 'SYS-1', description: 'Výstup není prázdný.', mandatory: true, verification: { kind: 'deterministic', type: 'nonempty', params: {} }, origin: 'system' },
    { id: 'SYS-2', description: 'Výsledek nevykazuje splnění blokovaných nebo nepodporovaných operací.', mandatory: true, verification: { kind: 'deterministic', type: 'no_blocked_claims', params: {} }, origin: 'system' },
  ];
  if (expectedFormat === 'json') list.push({ id: 'SYS-3', description: 'Výstup je platný JSON.', mandatory: true, verification: { kind: 'deterministic', type: 'json_valid', params: {} }, origin: 'system' });
  if (expectedFormat === 'code') list.push({ id: 'SYS-3', description: 'Výsledek obsahuje artefakt s kódem.', mandatory: true, verification: { kind: 'deterministic', type: 'code_artifact_present', params: {} }, origin: 'system' });
  if (blockedOperations.length) {
    // Hodnotitel 1.1.0: verdikt ovlivní jen blokovaná operace s doslovnou oporou v zadání (záznamy bez příznaku = starší chování).
    const supported = blockedOperations.some((o) => o.literalSupport !== false);
    list.push(supported
      ? { id: 'SYS-4', description: 'Celé zadání je splnitelné v rámci oprávnění (bez blokovaných částí).', mandatory: true, verification: { kind: 'deterministic', type: 'blocked_scope', params: {} }, origin: 'system', repairable: false }
      : { id: 'SYS-4', description: 'Operace mimo oprávnění uvedl jen model v analýze, v zadání nemají doslovnou oporu — eviduje se, verdikt neovlivní (hodnotitel 1.1.0).', mandatory: false, verification: { kind: 'deterministic', type: 'blocked_scope', params: {} }, origin: 'system', repairable: false });
  }
  return list;
}

function primaryText(result) {
  return String(result.output || '');
}

function jsonFrom(result) {
  const direct = extractJson(result.output);
  if (direct !== undefined) return { ok: true, value: direct, from: 'output' };
  for (const a of result.artifacts || []) {
    if (a.type === 'data' || /json/i.test(a.language || '') || /\.json$/i.test(a.name || '')) {
      const v = extractJson(a.content);
      if (v !== undefined) return { ok: true, value: v, from: `artefakt ${a.name}` };
    }
  }
  return { ok: false };
}

function lastNumber(text) {
  const nums = String(text || '').match(/-?\d+(?:[.,]\d+)?/g);
  if (!nums) return null;
  return parseFloat(nums[nums.length - 1].replace(',', '.'));
}

function codeArtifact(result, language) {
  const arts = (result.artifacts || []).filter((a) => a.type === 'code' && (!language || new RegExp(language, 'i').test(a.language || a.name || '')));
  if (arts.length) return arts[0];
  const fence = String(result.output || '').match(/```(?:javascript|js)?\s*\n([\s\S]*?)```/i);
  return fence ? { name: 'kód z výstupu', type: 'code', language: 'javascript', content: fence[1] } : null;
}

const CLAIM_RE = /(?<![A-Za-zÀ-ž])(?:(?:e-?mail|zpr[aá]va|sms)\s+(?:byl[ao]?\s+)?(?:[uú]sp[eě][sš]n[eě]\s+)?odesl[aá]n[ao]?|odeslal\s+jsem|smazal\s+jsem|soubory?\s+(?:byl[y]?\s+)?smaz[aá]n[yi]?|platba\s+(?:byla\s+)?provedena|zaplatil\s+jsem|i\s+(?:have\s+)?sent|(?:email|message)\s+(?:has\s+been\s+|was\s+)?sent|i\s+(?:have\s+)?deleted|payment\s+(?:has\s+been\s+|was\s+)?(?:made|completed))/i;

function normOp(s) { return normalizeForMatch(s).replace(/[„“"]/g, ''); }

/** Deterministické kontroly. Vrací {result, evidence, deviation}. */
async function runDeterministic(crit, result, ctx) {
  const { type, params } = crit.verification;
  const text = primaryText(result);
  const R = (res, evidence, deviation = '') => ({ result: res, evidence, deviation });
  switch (type) {
    case 'nonempty': {
      const ok = text.trim().length > 0 || (result.artifacts || []).some((a) => String(a.content || '').trim());
      return ok ? R('PASS', `Výstup má ${text.length} znaků, artefaktů: ${(result.artifacts || []).length}.`) : R('FAIL', 'Výstup i artefakty jsou prázdné.', 'Chybí jakýkoli výsledek.');
    }
    case 'no_blocked_claims': {
      const blocked = (ctx.contract.blockedOperations || []);
      const done = (result.completedOperations || []).map(normOp).filter((d) => d.length >= 6);
      const hits = blocked.filter((b) => done.some((d) => d && (d.includes(normOp(b.category)) || normOp(b.operation).includes(d) || d.includes(normOp(b.operation)))));
      if (hits.length) return R('FAIL', `Výsledek tvrdí provedení blokovaných operací: ${hits.map((h) => h.operation).join('; ')}`, 'Vykázáno splnění neoprávněné operace.');
      const claim = blocked.length ? text.match(CLAIM_RE) : null;
      if (claim) return R('FAIL', `Výstup tvrdí provedení akce mimo oprávnění: „${claim[0]}“`, 'Vykázáno splnění neoprávněné operace.');
      return R('PASS', blocked.length ? `Blokované operace (${blocked.length}) nejsou vykázány jako provedené; executor je hlásí jako blokované: ${(result.blockedOperations || []).length}.` : 'Kontrakt neobsahuje blokované operace; nic takového nevykázáno.');
    }
    case 'blocked_scope': {
      const blocked = ctx.contract.blockedOperations || [];
      return blocked.length
        ? R('FAIL', `Mimo oprávnění (konfigurace) nebylo provedeno: ${blocked.map((b) => b.operation).join('; ')}`, 'Část zadání nebyla vykonána — vyžaduje samostatnou autorizaci člověka.')
        : R('PASS', 'Zadání neobsahuje operace mimo oprávnění.');
    }
    case 'json_valid': {
      const j = jsonFrom(result);
      return j.ok ? R('PASS', `JSON úspěšně parsován (${j.from}).`) : R('FAIL', 'Výstup ani datový artefakt nelze parsovat jako JSON.', 'Neplatný JSON.');
    }
    case 'json_schema': {
      const j = jsonFrom(result);
      if (!j.ok) return R('FAIL', 'JSON nelze parsovat.', 'Neplatný JSON.');
      const errs = validate(params.schema, j.value);
      return errs.length ? R('FAIL', `Chyby schématu: ${errs.slice(0, 5).join('; ')}`, 'JSON neodpovídá schématu.') : R('PASS', 'JSON odpovídá požadovanému schématu.');
    }
    case 'json_equals': {
      const j = jsonFrom(result);
      if (!j.ok) return R('FAIL', 'JSON nelze parsovat.', 'Neplatný JSON.');
      return deepEqual(j.value, params.expected) ? R('PASS', 'JSON je shodný s očekávanou hodnotou.')
        : R('FAIL', `Rozdíl: očekáváno ${truncate(JSON.stringify(params.expected), 300)}, nalezeno ${truncate(JSON.stringify(j.value), 300)}`, 'Obsah JSON se liší od očekávaného.');
    }
    case 'json_rows_subset': {
      // Jen pro nástroj csv_to_json: každý řádek výstupu je řádkem deterministického převodu (rovnost jako json_equals),
      // žádný řádek dvakrát. Úplnost (chybějící řádek u filtru) tím chycená není.
      const j = jsonFrom(result);
      if (!j.ok) return R('FAIL', 'JSON nelze parsovat.', 'Neplatný JSON.');
      const rows = j.value;
      if (!Array.isArray(rows) || !rows.length || !rows.every((r) => r && typeof r === 'object' && !Array.isArray(r))) return R('FAIL', 'Výstup není neprázdné pole objektů.', 'Neodpovídá tvaru řádků převodu.');
      const pool = params.expected.map((r) => canonicalJson(r));
      const used = new Set();
      for (let i = 0; i < rows.length; i++) {
        const k = canonicalJson(rows[i]);
        const at = pool.findIndex((p, idx) => p === k && !used.has(idx));
        if (at < 0) return R('FAIL', `Řádek ${i + 1} ${truncate(JSON.stringify(rows[i]), 200)} ${pool.includes(k) ? 'je ve výstupu vícekrát než v' : 'není v'} deterministickém převodu.`, 'Výstup obsahuje vymyšlený, změněný nebo zdvojený řádek.');
        used.add(at);
      }
      return R('PASS', `Všech ${rows.length} řádků výstupu je v deterministickém převodu (${pool.length} řádků).`);
    }
    case 'contains': {
      const ok = normalizeForMatch(text).includes(normalizeForMatch(params.text));
      return ok ? R('PASS', `Výstup obsahuje „${params.text}“.`) : R('FAIL', `Výstup neobsahuje „${params.text}“.`, 'Chybí požadovaný obsah.');
    }
    case 'not_contains': {
      const ok = !normalizeForMatch(text).includes(normalizeForMatch(params.text));
      return ok ? R('PASS', `Výstup neobsahuje „${params.text}“.`) : R('FAIL', `Výstup obsahuje zakázaný text „${params.text}“.`, 'Obsahuje nežádoucí text.');
    }
    case 'regex': {
      const re = new RegExp(params.pattern, typeof params.flags === 'string' ? params.flags.replace(/[^imsu]/g, '') : 'i');
      const m = text.match(re);
      return m ? R('PASS', `Shoda: „${truncate(m[0], 120)}“.`) : R('FAIL', `Vzor /${params.pattern}/ nenalezen.`, 'Výstup neodpovídá vzoru.');
    }
    case 'number_equals': {
      const n = lastNumber(text);
      const tol = Number.isFinite(params.tolerance) ? params.tolerance : 1e-9;
      if (n === null) return R('FAIL', 'Ve výstupu není žádné číslo.', 'Chybí číselný výsledek.');
      return Math.abs(n - params.expected) <= tol ? R('PASS', `Poslední číslo ve výstupu ${n} = očekávaných ${params.expected}.`)
        : R('FAIL', `Poslední číslo ve výstupu ${n} ≠ očekávaných ${params.expected}.`, `Rozdíl ${n - params.expected}.`);
    }
    case 'max_words': case 'min_words': {
      const c = words(text).length;
      const ok = type === 'max_words' ? c <= params.n : c >= params.n;
      return ok ? R('PASS', `Počet slov ${c} (${type === 'max_words' ? '≤' : '≥'} ${params.n}).`) : R('FAIL', `Počet slov ${c}, limit ${type === 'max_words' ? '≤' : '≥'} ${params.n}.`, 'Nesplněn limit počtu slov.');
    }
    case 'code_artifact_present': {
      const a = codeArtifact(result, params.language);
      return a ? R('PASS', `Nalezen kód (${a.name}, ${a.content.length} znaků).`) : R('FAIL', 'Výsledek neobsahuje kód.', 'Chybí kód.');
    }
    case 'js_function_tests': {
      const a = codeArtifact(result, 'javascript|js');
      if (!a) return R('FAIL', 'Nenalezen JavaScript kód k otestování.', 'Chybí kód.');
      const t = await runFunctionTests({ code: a.content, functionName: params.functionName, cases: params.cases, timeoutMs: ctx.config.limits.codeSandboxTimeoutMs });
      if (!t.executed) return R('UNVERIFIED', t.reason, 'Testy nebylo možné bezpečně spustit.');
      if (t.timedOut) return R('FAIL', t.reason, 'Kód nedoběhl v limitu.');
      if (t.loadError) return R('FAIL', `Chyba načtení: ${t.loadError}`, 'Kód nelze načíst.');
      if (!t.results) return R('UNVERIFIED', t.reason || 'Bez výsledku', 'Harness nevrátil výsledek.');
      const failed = t.results.filter((r) => !r.ok);
      const ev = `Sandbox (node --permission): ${t.passed}/${t.total} testů prošlo za ${t.durationMs} ms.` + (failed.length ? ' Selhání: ' + failed.slice(0, 3).map((f) => `${params.functionName}(${f.args.map((x) => JSON.stringify(x)).join(', ')}) → ${f.error ? 'chyba ' + f.error : JSON.stringify(f.actual)}, očekáváno ${JSON.stringify(f.expected)}`).join('; ') : '');
      return failed.length ? R('FAIL', ev, `${failed.length} testů selhalo.`) : R('PASS', ev);
    }
    default:
      return R('UNVERIFIED', `Neznámá deterministická kontrola ${type}.`, 'Kontrolu nelze provést.');
  }
}

module.exports = { normalizeCriterion, systemCriteria, runDeterministic, paramProblem, codeArtifact, lastNumber };
