# FRANKENSTEIN v0.3 — samostatný autonomní cyklus úlohy

Lokální prototyp agenta, který zadání analyzuje podle deseti hledisek, nezávisle audituje cíl,
rozhodne podle pravidel A/B/C/D, vytvoří neměnný Goal Contract, algoritmicky sestaví exekuční prompt,
převezme výsledek, ověří ho proti akceptačním kritériím a vykáže telemetrii.

**Princip:** algoritmy řídí, AI interpretuje a tvoří. *Capabilities may grow; authority may not.*
Zadání: [`prompts/FRANKENSTEIN_v0.3_zadani.md`](prompts/FRANKENSTEIN_v0.3_zadani.md).

## Spuštění

Požadavky: Node.js 22+ (bez npm závislostí). Pro reálnou inferenci Claude Code CLI s předplatným.

```bash
start.cmd             # server na http://127.0.0.1:4173
start.cmd test        # deterministické testy (bez AI)
start.cmd preflight   # kontrola předplatitelského režimu CLI (bez inference)
```

Pokud `node` není v PATH: `set FR_NODE=C:\cesta\k\node.exe` (případně `npm start`, `npm test`, `npm run preflight`).

### Reálná inference (Claude Sonnet 5.5 přes Claude Code CLI)

Ve výchozím stavu je zablokovaná. Preflight musí projít všemi kontrolami:

1. CLI je nalezeno (konfigurace → `FR_CLAUDE_CLI` → PATH → `~/.local/bin` → CLI přibalené k desktop aplikaci).
2. `claude auth status` v čistém prostředí: `loggedIn=true`, metoda `claude.ai` (předplatné), `apiProvider=firstParty`.
3. V nastavení Claude Code není `apiKeyHelper` ani API proměnné.
4. **Ručně:** v claude.ai → Settings → Usage ověřte, že placená *extra usage* je vypnutá, a v
   `config/fr.config.json` nastavte `billing.extraUsageDisabledAttested: true`, `extraUsageAttestedBy`, `extraUsageAttestedAt`.
   Z CLI to ověřit nelze, proto je nutné potvrzení člověkem.

Neexistuje žádný provider pro přímé API ani placený fallback. Když preflight neprojde, běh skončí ve stavu `FAILED/BILLING_GUARD`
bez jediného volání.

## Architektura

```
src/core/pipeline.js       FR Core — stavový automat, limity, zámek 1 běhu, orchestrace
src/core/gate0.js          Gate 0 — 1 AI volání pro H1–H10 + deterministické úpravy priorit, ověření citací, H7/H8 z konfigurace
src/core/detectors.js      explicitní cíl, prompt injection, citlivá data, operace mimo oprávnění (regex, bez AI)
src/core/goalAudit.js      Goal Audit (izolované volání bez H1) + kvalitativní porovnání s evidencí původu
src/core/decision.js       rozhodovací tabulka A1/A2/A3/D1/B1/C1 (čistá funkce)
src/core/goalContract.js   neměnný, hashovaný a verzovaný Goal Contract (reviseContract = nová verze)
src/core/promptCompiler.js Prompt Compiler — deterministický, verzované šablony, bez AI
src/core/executor.js       deterministický nástroj → jinak AI přes provider
src/core/verifier.js       kritéria (deterministicky / sandbox / sémanticky), verdikt, rozhodnutí o opravě (max. 1)
src/core/criteria.js       typy kontrol a systémová kritéria SYS-1..4
src/core/telemetry.js      volání, tokeny, cache, časy AI vs. algoritmus, odhad USD vs. ověřená fakturace
src/core/store.js          JSON záznam běhu (data/runs), obnova po pádu = označení INTERRUPTED
src/tools/                 arith_eval, csv_to_json, text_stats, JS sandbox (node --permission)
src/providers/             mock (simulace), claude-cli (předplatné) + preflight + čisté prostředí
src/templates/             verzované šablony analytických volání
public/                    frontend (HTML/CSS/JS bez závislostí)
test/                      deterministické testy (node:test)
```

Stavový automat: `RECEIVED → GATE0 → GOAL_AUDIT → GOAL_COMPARE → DECISION → (CLARIFICATION_REQUIRED | CONTRACTS →
[COMPILE → EXECUTE → VERIFY → (REPAIR → VERIFY)] × větve → (BASELINE) → REPORT → DONE)`.

## Typický počet modelových volání na běh

Gate 0 (1) + audit (1) + porovnání (0–1) + exekuce (0–1 na větev) + sémantická verifikace (0–1 na větev a pokus) + oprava (0–2).
Typicky 4–5 volání, ve stavu C 7, strop je 14 (`limits.maxModelCallsPerRun`).

## Známá omezení

Viz závěrečný report; hlavní body: mock jen simuluje odpovědi modelu, sandbox JS není plnohodnotná bezpečnostní hranice
(síť v Node 24 permission modelu neomezuje, je jen staticky zakázána), deterministické detektory jsou hrubé (regex),
extra usage nelze ověřit strojově.
