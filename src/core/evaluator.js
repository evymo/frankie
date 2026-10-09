'use strict';
/**
 * Verze hodnoticí logiky (systémová kritéria + verifikátor) s historickou evidencí.
 * Oprava hodnotitele NENÍ „učení úspěchu“: je to samostatně verzovaná změna pravidel měření.
 * Řízené srovnání H-sestav je platné jen mezi výsledky hodnocenými STEJNOU verzí.
 */
const EVALUATOR_HISTORY = [
  { version: '1.0.0', date: '2026-10-09', release: 'v0.3.1', change: 'SYS-4 je povinné při jakékoli blokované operaci, včetně operace, kterou uvedl jen model v Gate 0.' },
  { version: '1.1.0', date: '2026-10-09', release: 'v0.4.0', change: 'SYS-4 je povinné jen pro blokovanou operaci s doslovnou oporou v zadání (deterministický detektor nebo doslovná citace). Operace uvedená jen modelem se dál neprovádí, SYS-2 dál zakazuje vykázat ji jako splněnou, ale verdikt ovlivní jen jako volitelné kritérium (PASSPORT v0.3.1 §6.1 — falešné PARTIAL u „Člověče nezlob se“).' },
];

const EVALUATOR_VERSION = EVALUATOR_HISTORY[EVALUATOR_HISTORY.length - 1].version;

/** Verze hodnotitele záznamu verifikace (běhy před v0.4 verzi neuváděly = 1.0.0). */
function evaluatorOf(verification) {
  return (verification && verification.evaluator) || '1.0.0';
}

module.exports = { EVALUATOR_VERSION, EVALUATOR_HISTORY, evaluatorOf };
