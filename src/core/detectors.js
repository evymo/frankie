'use strict';
/**
 * Deterministické detektory nad původním zadáním. Doplňují (nikoli nahrazují) sémantické posouzení modelu
 * a mají vyšší autoritu než tvrzení AI tam, kde jde o bezpečnost a oprávnění.
 */
const { stripDiacritics } = require('./util');

/** Explicitní cíl: pole formuláře má přednost, jinak řádek „Cíl: …“ / „Goal: …“ v zadání. */
function extractExplicitGoal(prompt, fieldValue) {
  const marker = String(prompt || '').match(/^[ \t>*-]*(?:c[ií]l|goal|z[aá]m[eě]r)[ \t]*[:：][ \t]*(.+)$/im);
  const promptMarker = marker ? { text: marker[1].trim(), index: marker.index } : null;
  const field = String(fieldValue || '').trim();
  if (field) return { text: field, source: 'field', promptMarker };
  if (promptMarker && promptMarker.text) return { text: promptMarker.text, source: 'prompt_marker', promptMarker };
  return { text: null, source: null, promptMarker: null };
}

const INJECTION_PATTERNS = [
  { id: 'ignore_previous', re: /ignor\p{L}*\s+(?:v[sš]echn\p{L}*\s+)?(?:p[rř]edchoz\p{L}*|p[rř]edešl\p{L}*|v[ýy][sš]e\s+uveden\p{L}*|previous|prior|above)\s+(?:instrukc\p{L}*|pokyn\p{L}*|instructions?|pravidl\p{L}*|rules?)/iu },
  { id: 'disregard_rules', re: /(?<!\p{L})(?:disregard|forget|override|obejdi|zapome[nň]\p{L}*\s+na)\s+(?:all\s+|v[sš]echn\p{L}*\s+)?(?:previous\s+|your\s+|sv[eé]\s+)?(?:instructions?|rules?|pravidla|instrukce|pokyny)/iu },
  { id: 'role_override', re: /(?<!\p{L})(?:you are now|from now on you are|nyn[ií] jsi|od te[dď] jsi|act as (?:an? )?(?:unrestricted|jailbroken))/iu },
  { id: 'system_prompt_probe', re: /(?<!\p{L})(?:system\s*prompt|syst[eé]mov\p{L}*\s+prompt|developer\s+mode|re[zž]im\s+v[yý]voj[aá][rř]e)/iu },
  { id: 'fake_authorization', re: /(?<!\p{L})(?:u[zž]ivatel|admin\p{L}*|anthropic|syst[eé]m)\s+(?:ji[zž]\s+)?(?:schv[aá]lil|autorizoval|povolil|authorized|approved)/iu },
  { id: 'hidden_markup', re: /<\s*\/?\s*(?:system|instructions?|admin)\s*>/iu },
];

function detectInjection(prompt) {
  const hits = [];
  for (const p of INJECTION_PATTERNS) {
    const m = String(prompt || '').match(p.re);
    if (m) hits.push({ pattern: p.id, match: m[0] });
  }
  return { suspected: hits.length > 0, hits };
}

const PII_PATTERNS = [
  { id: 'email', re: /[\w.+-]+@[\w-]+\.[\w.-]+/ },
  { id: 'phone', re: /(?:\+420\s?)?\b\d{3}\s?\d{3}\s?\d{3}\b/ },
  { id: 'birth_number', re: /\b\d{6}\/\d{3,4}\b/ },
  { id: 'iban', re: /\b[A-Z]{2}\d{2}(?:\s?\d{4}){4,7}\b/ },
  { id: 'card_number', re: /\b(?:\d{4}[ -]?){3}\d{4}\b/ },
  { id: 'secret_like', re: /\b(?:sk-[A-Za-z0-9_-]{16,}|api[_-]?key\s*[:=]\s*\S+|password\s*[:=]\s*\S+|heslo\s*[:=]\s*\S+)/iu },
];

function detectSensitiveData(prompt) {
  const hits = [];
  for (const p of PII_PATTERNS) if (p.re.test(String(prompt || ''))) hits.push(p.id);
  const level = hits.some((h) => ['birth_number', 'iban', 'card_number', 'secret_like'].includes(h)) ? 'high'
    : hits.length ? 'medium' : 'none';
  return { level, kinds: hits };
}

/** Klíčová slova operací mimo oprávnění (hrubý, ale deterministický záchyt). */
const OPERATION_PATTERNS = [
  { category: 'external_communication', re: /(?<!\p{L})(?:po[sš]li|ode[sš]li|send|email\s+to|napi[sš]\s+e-?mail\s+(?:na|komu)|zprávu\s+na|sms\s+na|post(?:ni|uj)?\s+na)/iu, label: 'odeslání zprávy / komunikace navenek' },
  { category: 'filesystem_write', re: /(?<!\p{L})(?:sma[zž]\s+(?:soubor|slo[zž]k|disk|v[sš]e)|delete\s+(?:the\s+)?files?|rm\s+-rf|ulo[zž]\s+(?:do|na)\s+(?:disk|soubor)|p[rř]epi[sš]\s+soubor|format\p{L}*\s+disk)/iu, label: 'zápis/mazání v souborovém systému' },
  { category: 'payment', re: /(?<!\p{L})(?:zapla[tť]|plat(?:bu|ba)\s+(?:na|kartou)|p[rř]eve[dď]\s+\d+\s*(?:k[cč]|eur|usd|\$)|kup\s+(?:mi\s+)?|purchase|buy\s+)/iu, label: 'platba / nákup' },
  { category: 'network', re: /(?<!\p{L})(?:st[aá]hni|download|otev[rř]i\s+(?:web|str[aá]nku)|na[cč]ti\s+(?:z\s+)?(?:url|webu|internetu)|https?:\/\/\S+\s+(?:a\s+)?(?:na[cč]ti|st[aá]hni|zkontroluj))/iu, label: 'přístup k síti / webu' },
  { category: 'system_change', re: /(?<!\p{L})(?:nainstaluj|install\s+|zm[eě][nň]\s+(?:nastaven[ií]\s+)?(?:syst[eé]m|registr)|spus[tť]\s+(?:p[rř][ií]kaz|skript)\s+na\s+(?:serveru|po[cč][ií]ta[cč]i))/iu, label: 'změna systému / instalace' },
  { category: 'credential_use', re: /(?<!\p{L})(?:p[rř]ihla[sš]\s+se|log\s*in\s+(?:to|as)|pou[zž]ij\s+(?:moje|toto)\s+heslo)/iu, label: 'použití přihlašovacích údajů' },
];

function detectOperations(prompt) {
  const s = String(prompt || '');
  const ops = [];
  for (const p of OPERATION_PATTERNS) {
    const m = s.match(p.re);
    if (m) ops.push({ operation: `${p.label}: „${m[0].trim()}“`, category: p.category, source: 'deterministic_detector' });
  }
  return ops;
}

/** Hrubé rozpoznání typu úlohy (jen záložní informace; autoritativní typ určuje H2 modelu). */
function guessTaskType(prompt) {
  const s = stripDiacritics(String(prompt || '').toLowerCase());
  if (/\b(funkc|program|skript|kod|implementuj|function|algoritm)/.test(s) && /(napis|vytvor|implementuj|write|create|naprogramuj)/.test(s)) return 'code';
  if (/\b(csv|json|tabulk|prevod|preved|transform|xml|yaml)/.test(s)) return 'structured_transformation';
  if (/\d\s*[-+*/^×÷]\s*\d/.test(s) || /(vypocitej|spocitej|kolik je|calculate|compute)/.test(s)) return 'math';
  if (/(analyz|shrn|sumariz|summar|vyhodnot\s+text|text)/.test(s)) return 'text_analysis';
  if (/\?\s*$/.test(s.trim())) return 'question_answering';
  return 'other';
}

module.exports = { extractExplicitGoal, detectInjection, detectSensitiveData, detectOperations, guessTaskType, INJECTION_PATTERNS };
