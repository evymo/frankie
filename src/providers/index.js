'use strict';
/**
 * Registr providerů. Záměrně obsahuje JEN mock, Claude Code CLI a Codex CLI (předplatné).
 * Neexistuje žádný provider pro přímé Anthropic API ani jiný zpoplatněný fallback.
 */
const path = require('path');
const os = require('os');
const { MockProvider } = require('./mock');
const { ClaudeCliProvider } = require('./claudeCli');
const { CodexCliProvider } = require('./codexCli');

const ALLOWED_PROVIDER_IDS = Object.freeze(['mock', 'claude-cli', 'codex-cli']);

function createProviders(config) {
  return {
    mock: new MockProvider({ model: config.providers.mock.model }),
    // Pracovní adresář CLI mimo projekt i Google Drive: žádný CLAUDE.md ani projektová nastavení v okolí.
    'claude-cli': new ClaudeCliProvider({ config, sandboxDir: path.join(os.tmpdir(), 'fr-cli-sandbox') }),
    'codex-cli': new CodexCliProvider({ config, sandboxDir: path.join(os.tmpdir(), 'fr-codex-sandbox') }),
  };
}

module.exports = { createProviders, ALLOWED_PROVIDER_IDS };
