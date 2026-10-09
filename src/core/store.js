'use strict';
/** Lokální perzistentní evidence běhů: jeden JSON soubor na běh, atomický zápis (tmp + rename). */
const fs = require('fs');
const path = require('path');

const TERMINAL = new Set(['DONE', 'FAILED', 'CLARIFICATION_REQUIRED']);

class RunStore {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  file(id) {
    if (!/^[A-Za-z0-9-]+$/.test(id)) throw new Error('Neplatné ID běhu');
    return path.join(this.dir, `${id}.json`);
  }

  save(run) {
    const f = this.file(run.id);
    const tmp = `${f}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(run, null, 2), 'utf8');
    fs.renameSync(tmp, f);
  }

  load(id) {
    const f = this.file(id);
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  }

  list() {
    return fs.readdirSync(this.dir).filter((n) => n.endsWith('.json')).map((n) => {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(this.dir, n), 'utf8'));
        return {
          id: r.id, createdAt: r.createdAt, state: r.state, provider: r.provider && r.provider.id,
          simulated: r.provider && r.provider.simulated, decision: r.decision && r.decision.code,
          verdicts: (r.branches || []).map((b) => b.finalVerdict).filter(Boolean),
          promptPreview: String(r.input && r.input.prompt || '').slice(0, 120), parentRunId: r.input && r.input.parentRunId,
        };
      } catch (_) { return null; }
    }).filter(Boolean).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  /** Po pádu serveru: nedokončené běhy označ jako přerušené (nikdy je tiše neobnovuj). */
  recoverInterrupted() {
    const fixed = [];
    for (const r of this.list()) {
      if (!TERMINAL.has(r.state)) {
        const run = this.load(r.id);
        run.stateHistory.push({ state: 'FAILED', at: new Date().toISOString(), note: 'Běh přerušen restartem serveru.' });
        run.state = 'FAILED';
        run.error = { code: 'INTERRUPTED', message: 'Běh byl přerušen (restart serveru). Nespouští se znovu automaticky.' };
        this.save(run);
        fixed.push(r.id);
      }
    }
    return fixed;
  }
}

module.exports = { RunStore, TERMINAL };
