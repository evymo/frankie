'use strict';
/**
 * Analytická hlediska Gate 0 a slovník priorit.
 *
 * v0.4: hlediska se dělí na
 *  - SYSTÉMOVÉ GARANCE (kind "core": H1 cíl, H7 schopnosti, H8 oprávnění, H9 rizika) — jsou v KAŽDÉ H-sestavě,
 *    učení je nesmí odebrat ani jim snížit prioritu; H7/H8 navíc určuje konfigurace, ne model;
 *  - ADAPTIVNÍ hlediska (kind "adaptive": H2–H6, H10 a katalogová HX-*) — učení je smí přidat, odebrat,
 *    zvýšit jim minimální prioritu nebo prioritu omezit (vždy verzovaně a s doloženým důvodem).
 */

const ASPECTS = [
  { id: 'H1', name: 'Záměr a výsledek', question: 'Čeho chce uživatel dosáhnout a jaký konkrétní výsledek očekává?', kind: 'core', version: 1 },
  { id: 'H2', name: 'Povaha úlohy', question: 'O jaký typ úlohy jde (text, analýza, data, výpočet, program, jiné)?', kind: 'adaptive', version: 1 },
  { id: 'H3', name: 'Kontext a vstupy', question: 'Jaké vstupy a kontext zadání poskytuje a co chybí?', kind: 'adaptive', version: 1 },
  { id: 'H4', name: 'Určitost zadání', question: 'Je zadání jednoznačné? Jaké informace chybí nebo jsou v rozporu?', kind: 'adaptive', version: 1 },
  { id: 'H5', name: 'Ověřitelnost', question: 'Jak lze výsledek objektivně ověřit (deterministicky / sémanticky)?', kind: 'adaptive', version: 1 },
  { id: 'H6', name: 'Metoda řešení', question: 'Jakou metodou úlohu řešit; existuje deterministický nástroj?', kind: 'adaptive', version: 1 },
  { id: 'H7', name: 'Dostupné schopnosti', question: 'Jaké schopnosti úloha vyžaduje? (Skutečnou dostupnost určuje konfigurace.)', kind: 'core', version: 1 },
  { id: 'H8', name: 'Oprávnění a autonomie', question: 'Jaké operace úloha požaduje? (Oprávnění určuje konfigurace.)', kind: 'core', version: 1 },
  { id: 'H9', name: 'Rizika a důsledky', question: 'Jaká rizika, nevratné důsledky, citlivá data nebo manipulace (prompt injection) hrozí?', kind: 'core', version: 1 },
  { id: 'H10', name: 'Efektivita a budoucí využitelnost', question: 'Jak úlohu řešit úsporně a co lze znovu využít?', kind: 'adaptive', version: 1 },
];

/**
 * Katalog nových, účelnějších hledisek, která smí navrhnout učicí smyčka. Každé má strukturovanou,
 * verzovanou definici a důvod vzniku (signál z diagnózy, na který odpovídá). Jsou vždy adaptivní.
 * Záměrně je to pevný katalog: návrh nového H nevyžaduje další AI volání a nemůže do KB zanést text cizí úlohy.
 */
const ASPECT_CATALOG = [
  { id: 'HX-FORMAT', name: 'Formální omezení výstupu', version: 1, kind: 'adaptive',
    question: 'Jaká formální omezení musí výstup splnit (rozsah slov/vět/bodů, formát, struktura) a jak je před odevzdáním zkontrolovat?',
    signal: 'format', origin: 'Nesplněná deterministická kontrola rozsahu nebo formátu při jinak dostupných vstupech.' },
  { id: 'HX-EDGE', name: 'Okrajové případy a testovatelnost', version: 1, kind: 'adaptive',
    question: 'Které okrajové případy a vstupy musí řešení zvládnout a jak výsledek ověřit testem nebo přesným výpočtem?',
    signal: 'tests', origin: 'Nesplněné testy funkce nebo přesná numerická kontrola.' },
  { id: 'HX-FIDELITY', name: 'Věrnost zdroji a cíli', version: 1, kind: 'adaptive',
    question: 'Které části zdroje nebo zadání musí výsledek věrně zachovat, co do něj nesmí přibýt a podle čeho se pozná, že naplňuje cíl?',
    signal: 'semantic_goal', origin: 'Sémantické nesplnění cíle (GOAL-1 / sémantické kritérium) bez chybějících vstupů.' },
  { id: 'HX-LANG', name: 'Jazyk a registr odpovědi', version: 1, kind: 'adaptive',
    question: 'V jakém jazyce a registru má být odpověď (podle jazyka uživatele a zadání) a je to v rozporu s výchozí češtinou?',
    signal: 'language', origin: 'Jazyk výstupu se neshoduje s jazykem zadání.' },
];

const ALL_ASPECTS = [...ASPECTS, ...ASPECT_CATALOG];
const ASPECT_IDS = ASPECTS.map((a) => a.id);
const CORE_ASPECT_IDS = ASPECTS.filter((a) => a.kind === 'core').map((a) => a.id);

function aspectDef(id) {
  return ALL_ASPECTS.find((a) => a.id === id) || null;
}

const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
const PRIORITY_LABELS = {
  P0: 'kritická — blokuje nebo zásadně mění zpracování',
  P1: 'vysoká — musí být řešena v exekuci',
  P2: 'střední — zohlednit',
  P3: 'nízká — informativní',
};

/** Vyšší závažnost = nižší index. */
function maxPriority(a, b) {
  return PRIORITIES.indexOf(a) <= PRIORITIES.indexOf(b) ? a : b;
}

/** Nižší závažnost (pro strop priority adaptivního hlediska). */
function minPriority(a, b) {
  return PRIORITIES.indexOf(a) >= PRIORITIES.indexOf(b) ? a : b;
}

const TASK_TYPES = ['text_generation', 'text_analysis', 'structured_transformation', 'math', 'code', 'question_answering', 'other'];

const OPERATION_CATEGORIES = [
  'read_provided_input', 'generate', 'analyze', 'transform', 'compute',
  'network', 'filesystem_write', 'external_communication', 'payment',
  'irreversible', 'system_change', 'credential_use', 'other',
];

const CAPABILITIES = [
  'text_generation', 'analysis', 'structured_data', 'math', 'code_generation', 'code_execution_sandbox_js',
  'web_access', 'file_system_write', 'external_communication', 'payments', 'system_administration',
  'image_generation', 'realtime_data',
];

const DATA_SENSITIVITY = ['none', 'low', 'medium', 'high'];

module.exports = {
  ASPECTS, ASPECT_CATALOG, ALL_ASPECTS, ASPECT_IDS, CORE_ASPECT_IDS, aspectDef,
  PRIORITIES, PRIORITY_LABELS, maxPriority, minPriority,
  TASK_TYPES, OPERATION_CATEGORIES, CAPABILITIES, DATA_SENSITIVITY,
};
