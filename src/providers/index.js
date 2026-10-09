'use strict';
/**
 * Registr providerů. Záměrně obsahuje JEN mock a Claude Code CLI (předplatné).
 * Neexistuje žádný provider pro přímé Anthropic API ani jiný zpoplatněný fallback.
 */
const path = require('path');
const os = require('os');
const { MockProvider } = require('./mock');
const { ClaudeCliProvider } = require('./claudeCli');

const ALLOWED_PROVIDER_IDS = Object.freeze(['mock', 'claude-cli']);

function createProviders(config) {
  return {
    mock: new MockProvider({ model: config.providers.mock.model }),
    // Pracovní adresář CLI mimo projekt i Google Drive: žádný CLAUDE.md ani projektová nastavení v okolí.
    'claude-cli': new ClaudeCliProvider({ config, sandboxDir: path.join(os.tmpdir(), 'fr-cli-sandbox') }),
  };
}

module.exports = { createProviders, ALLOWED_PROVIDER_IDS };
