'use strict';
/** Deset univerzálních hledisek Gate 0 a slovník priorit. */

const ASPECTS = [
  { id: 'H1', name: 'Záměr a výsledek', question: 'Čeho chce uživatel dosáhnout a jaký konkrétní výsledek očekává?' },
  { id: 'H2', name: 'Povaha úlohy', question: 'O jaký typ úlohy jde (text, analýza, data, výpočet, program, jiné)?' },
  { id: 'H3', name: 'Kontext a vstupy', question: 'Jaké vstupy a kontext zadání poskytuje a co chybí?' },
  { id: 'H4', name: 'Určitost zadání', question: 'Je zadání jednoznačné? Jaké informace chybí nebo jsou v rozporu?' },
  { id: 'H5', name: 'Ověřitelnost', question: 'Jak lze výsledek objektivně ověřit (deterministicky / sémanticky)?' },
  { id: 'H6', name: 'Metoda řešení', question: 'Jakou metodou úlohu řešit; existuje deterministický nástroj?' },
  { id: 'H7', name: 'Dostupné schopnosti', question: 'Jaké schopnosti úloha vyžaduje? (Skutečnou dostupnost určuje konfigurace.)' },
  { id: 'H8', name: 'Oprávnění a autonomie', question: 'Jaké operace úloha požaduje? (Oprávnění určuje konfigurace.)' },
  { id: 'H9', name: 'Rizika a důsledky', question: 'Jaká rizika, nevratné důsledky, citlivá data nebo manipulace (prompt injection) hrozí?' },
  { id: 'H10', name: 'Efektivita a budoucí využitelnost', question: 'Jak úlohu řešit úsporně a co lze znovu využít?' },
];

const ASPECT_IDS = ASPECTS.map((a) => a.id);

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
  ASPECTS, ASPECT_IDS, PRIORITIES, PRIORITY_LABELS, maxPriority,
  TASK_TYPES, OPERATION_CATEGORIES, CAPABILITIES, DATA_SENSITIVITY,
};
