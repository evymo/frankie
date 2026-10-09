'use strict';
/**
 * Verze hodnoticí logiky (systémová kritéria + verifikátor) s historickou evidencí.
 * Oprava hodnotitele NENÍ „učení úspěchu“: je to samostatně verzovaná změna pravidel měření.
 * Řízené srovnání H-sestav je platné jen mezi výsledky hodnocenými STEJNOU verzí.
 */
const EVALUATOR_HISTORY = [
  { version: '1.0.0', date: '2026-10-09', release: 'v0.3.1', change: 'SYS-4 je povinné při jakékoli blokované operaci, včetně operace, kterou uvedl jen model v Gate 0.' },
  { version: '1.1.0', date: '2026-10-09', release: 'v0.4.0', change: 'SYS-4 je povinné jen pro blokovanou operaci s doslovnou oporou v zadání (deterministický detektor nebo doslovná citace). Operace uvedená jen modelem se dál neprovádí, SYS-2 dál zakazuje vykázat ji jako splněnou, ale verdikt ovlivní jen jako volitelné kritérium (PASSPORT v0.3.1 §6.1 — falešné PARTIAL u „Člověče nezlob se“).' },
  { version: '1.2.0', date: '2026-10-09', release: 'v0.4.2', change: 'Výsledek deterministického nástroje je povinný vždy, bez ohledu na fullySolves od modelu: arith_eval TOOL-1 (bench S01: 201 × 198 vyšlo PASS a učení z toho navrhlo redukci). csv_to_json: TOOL-1 json_rows_subset povinné vždy (nic vymyšleného ani zdvojeného), TOOL-2 úplná shoda jen při fullySolves. Neúplnost u filtru zatím chycená není (M-FR1).' },
  { version: '1.3.0', date: '2026-10-09', release: 'v0.4.3', change: 'Nález 7 (bench gpu-qwen S01): (d) veto nástroje při vzniku kontraktu — kritérium z modelu s hodnotou výsledku v rozporu s nástrojem (number_equals nebo ohlášený výsledek v popisu) se nahradí kontrolou hodnoty nástroje a rozpor se zapíše jako nález kontraktu (proposed); oprava tak nikdy nedostane pokyn splnit kontaminované kritérium. (e) number_equals bere ohlášený výsledek před posledním číslem (src/core/numbers.js, jeden výklad s orákl benchmarku): „je 201 … i když výpočet dává 198“ je FAIL. (f) diagnóza: rozpor kontraktu s nástrojem je příčina kontrakt/verifikace, H-sestavě se nepřipisuje a z běhu nevzniká hypotéza (ani redukce).' },
];

const EVALUATOR_VERSION = EVALUATOR_HISTORY[EVALUATOR_HISTORY.length - 1].version;

/** Verze hodnotitele záznamu verifikace (běhy před v0.4 verzi neuváděly = 1.0.0). */
function evaluatorOf(verification) {
  return (verification && verification.evaluator) || '1.0.0';
}

module.exports = { EVALUATOR_VERSION, EVALUATOR_HISTORY, evaluatorOf };
