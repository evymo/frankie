'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function loadConfig(file = process.env.FR_CONFIG || path.join(ROOT, 'config', 'fr.config.json')) {
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Tvrdé stropy nezávislé na konfiguraci: max. 1 oprava, žádný paralelismus, max. 1 opakování volání.
  cfg.limits.maxRepairPasses = Math.min(1, Math.max(0, cfg.limits.maxRepairPasses | 0));
  cfg.limits.parallelism = 1;
  cfg.limits.maxRetriesPerCall = Math.min(1, Math.max(0, cfg.limits.maxRetriesPerCall | 0));
  cfg.limits.maxModelCallsPerRun = Math.min(20, Math.max(1, cfg.limits.maxModelCallsPerRun | 0));
  if (!['mock', 'claude-cli'].includes(cfg.defaultProvider)) cfg.defaultProvider = 'mock';
  // Učení (v0.4): ověření vyžaduje vždy alespoň 2 reálná řízená srovnání; reálné experimenty jsou ve výchozím stavu vypnuté.
  const l = cfg.learning || {};
  const re = l.realExperiments || {};
  cfg.learning = {
    enabled: l.enabled !== false,
    verifyMinWins: Math.max(2, l.verifyMinWins | 0),
    maxExperiences: Math.max(50, l.maxExperiences | 0 || 1000),
    realExperiments: { enabled: re.enabled === true, maxPerDay: Math.min(10, Math.max(0, re.maxPerDay | 0)), note: re.note || '' },
  };
  return cfg;
}

module.exports = { loadConfig, ROOT };
