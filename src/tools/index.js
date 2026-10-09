'use strict';
/** Registr bezpečných deterministických nástrojů. Model je smí jen navrhnout; použití validuje algoritmus. */
const { evaluate } = require('./arith');
const { csvToJson } = require('./csv');
const { textStats } = require('./textStats');

const TOOLS = {
  arith_eval: {
    description: 'Přesný výpočet aritmetického výrazu (+ - * / ^ závorky, sqrt, abs, round).',
    outputFormat: 'number',
    run: (input) => evaluate(input),
    render: (input, value) => `Výpočet: ${input} = ${value}\nVýsledek: ${value}`,
  },
  csv_to_json: {
    description: 'Převod CSV s hlavičkou na pole JSON objektů (čísla a boolean převedeny).',
    outputFormat: 'json',
    run: (input) => csvToJson(input),
    render: (_input, value) => JSON.stringify(value, null, 2),
  },
  text_stats: {
    description: 'Počet slov, vět, znaků a nejčastější slova textu.',
    outputFormat: 'json',
    run: (input) => textStats(input),
    render: (_input, value) => JSON.stringify(value, null, 2),
  },
};

function runTool(name, input) {
  const tool = TOOLS[name];
  if (!tool) return { ok: false, error: `Neznámý nástroj ${name}` };
  const started = Date.now();
  try {
    const value = tool.run(input);
    return { ok: true, tool: name, input, value, rendered: tool.render(input, value), outputFormat: tool.outputFormat, durationMs: Date.now() - started };
  } catch (e) {
    return { ok: false, tool: name, input, error: e.message, durationMs: Date.now() - started };
  }
}

module.exports = { TOOLS, runTool };
