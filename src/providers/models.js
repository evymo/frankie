'use strict';
// Ověřeno 2026-10-09: Claude Code model-config a katalog codex debug models.
const MODEL_CATALOG = Object.freeze({
  'claude-cli': Object.freeze([
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', minCliVersion: '2.1.284' },
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', minCliVersion: '2.1.280' },
    { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', minCliVersion: '2.1.293' },
    { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', disabled: true,
      reason: 'Fable může vyžadovat placené usage credits; v režimu pouze předplatného není povolen.' },
  ].map(Object.freeze)),
  'codex-cli': Object.freeze([
    { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' },
    { id: 'gpt-6-astra', label: 'GPT-6 Astra' },
    { id: 'gpt-6-sol', label: 'GPT-6 Sol' },
    { id: 'gpt-6-luna', label: 'GPT-6 Luna' },
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
  ].map(Object.freeze)),
});
function modelsFor(provider) {
  if (provider.simulated) return [{ id: provider.model, label: 'Deterministický mock' }];
  // Katalog vestavěných CLI má přednost (zákaz Fable a placených modelů nejde obejít);
  // provider mimo katalog (např. integrační harness) smí seznam dodat sám — bez větvení podle id v jádru.
  return MODEL_CATALOG[provider.id] || (typeof provider.models === 'function' ? provider.models() : []);
}
function selectProviderModel(provider, requested) {
  const model = requested === undefined || requested === null ? provider.model : requested;
  const entry = modelsFor(provider).find(m => m.id === model);
  if (!entry || entry.disabled) {
    const error = new Error(entry?.reason || 'Model není povolen pro zvolený provider.');
    error.code = 'BAD_MODEL';
    throw error;
  }
  return provider.model === model && !provider.requiresPreflight ? provider : provider.withModel(entry);
}
module.exports = { MODEL_CATALOG, modelsFor, selectProviderModel };
