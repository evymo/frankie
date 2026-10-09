# FRANKENSTEIN v0.4 — autonomní cyklus úlohy s adaptivním učením hledisek

Lokální prototyp agenta, který zadání analyzuje podle deseti hledisek, nezávisle audituje cíl,
rozhodne podle pravidel A/B/C/D, vytvoří neměnný Goal Contract, algoritmicky sestaví exekuční prompt,
převezme výsledek, ověří ho proti akceptačním kritériím a vykáže telemetrii.

**v0.4:** FR určí charakteristiku zadání (bez AI), podle doložených zkušeností ze sdílené Knowledge Base (`knowledge/`) zvolí analytickou
sestavu hledisek (H-sestavu), diagnostikuje odchylky (oprávnění / vstupy / exekuce / hodnotitel / strategie), navrhuje
kandidátní změny sestavy a ověřuje je řízeným srovnáním proti témuž zamčenému Goal Contract. Aktivně se použije jen
opakovaně ověřená zkušenost; systémové garance H1/H7/H8/H9 se nikdy neučí. UI ukazuje živý průběh práce a modře
odlišenou hlavní odpověď. Kvalitativní účinnost H-sestav na reálném modelu **zatím čeká na ověření** reálnými experimenty.

**Princip:** algoritmy řídí, AI interpretuje a tvoří. *Capabilities may grow; authority may not.*
Zadání: [`prompts/`](prompts/README.md) (konvence prompts-as-repo a index; aktuálně
[`v0.4`](prompts/FRANKENSTEIN_v0.4_adaptive_h_learning_ui_CC.md), dříve [`v0.3`](prompts/FRANKENSTEIN_v0.3_zadani.md)).
Architektura a principy v0.4: [`docs/ARCHITEKTURA-v0.4.md`](docs/ARCHITEKTURA-v0.4.md).
Výchozí stav v0.3.1, reálné běhy a známé vady: [`docs/PASSPORT-v0.3.1.md`](docs/PASSPORT-v0.3.1.md).

## Spuštění

Požadavky: Node.js 22+ (bez npm závislostí). Pro reálnou inferenci Claude Code CLI s předplatným nebo Codex CLI s ChatGPT přihlášením.

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
src/core/pipeline.js       FR Core — stavový automat, limity, zámek 1 běhu, orchestrace, události průběhu (run.events)
src/core/profile.js        v0.4: charakteristika zadání (bez AI) a kvalitativní shoda profilů
src/core/aspectSets.js     v0.4: verzované H-sestavy; invarianty systémových garancí H1/H7/H8/H9
src/core/knowledge.js      v0.4: sdílená Knowledge Base (knowledge/, append-only), výběr sestavy, stavy důvěryhodnosti
src/core/learning.js       v0.4: diagnóza příčin, kandidátní hypotézy, řízené srovnání
src/core/evaluator.js      v0.4: verze hodnotitele s historií (SYS-4 1.1.0)
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
src/providers/             mock (simulace), claude-cli a codex-cli (předplatné) + preflight + čisté prostředí
src/templates/             verzované šablony analytických volání
public/                    frontend (HTML/CSS/JS bez závislostí)
test/                      deterministické testy (node:test)
```

Stavový automat: `RECEIVED → PROFILE → GATE0 → GOAL_AUDIT → GOAL_COMPARE → DECISION → (CLARIFICATION_REQUIRED | CONTRACTS →
[COMPILE → EXECUTE → VERIFY → (REPAIR → VERIFY)] × větve → (BASELINE) → REPORT → LEARN → DONE)`.
Řízený experiment H-sestavy: `RECEIVED → PROFILE → GATE0 → CONTRACTS (zamčený z původního běhu) → … → LEARN → DONE`.

## Zobrazení

Přepínač **Provozní / Detailní** v horní liště: provozní = jen zadání, stručný postup a odpověď (jako běžný agent),
detailní = celý vnitřní průběh FR (hlediska, kontrakty, verifikace, učení, telemetrie). Přepnout lze kdykoli.

## Učení (v0.4) — provoz

- Knowledge Base je **sdílená v repozitáři** v [`knowledge/`](knowledge/README.md) (jeden soubor na záznam, týmová práce
  přes `git pull/push`). Obsahuje jen metodu — ne texty zadání, výstupy ani hash zadání. Plné běhy (`data/runs`) zůstávají mimo Git.
- Simulované (mock) experimenty jsou povolené vždy a do důvěryhodnosti se nezapočítávají.
- Reálný experiment (3–5 volání Claude CLI) vyžaduje `learning.realExperiments.enabled: true` v `config/fr.config.json`
  **a** potvrzení v UI; denní limit `maxPerDay`. Ve výchozím stavu vypnuto.
- Pro jeden běh lze vynutit výchozí sestavu zaškrtnutím „Výchozí H-sestava“.

## Typický počet modelových volání na běh

Gate 0 (1) + audit (1) + porovnání (0–1) + exekuce (0–1 na větev) + sémantická verifikace (0–1 na větev a pokus) + oprava (0–2).
Profil, výběr H-sestavy, diagnóza a aktualizace znalostí jsou bez AI volání. Řízený experiment: 3–5 volání.
Typicky 4–5 volání, ve stavu C 7, strop je 14 (`limits.maxModelCallsPerRun`).

## Známá omezení

Viz závěrečný report; hlavní body: mock jen simuluje odpovědi modelu, sandbox JS není plnohodnotná bezpečnostní hranice
(síť v Node 24 permission modelu neomezuje, je jen staticky zakázána), deterministické detektory jsou hrubé (regex),
extra usage nelze ověřit strojově.

### Reálná inference přes Codex CLI (ChatGPT přihlášení)

V rozhraní je samostatný provider **Codex CLI**. Žádný automatický přechod mezi providery ani přímé API se nepoužívá.
Preflight pro každého CLI providera běží zvlášť a lze ho opakovat v dialogu providerů.

1. Nainstalujte Codex CLI s podporou izolačních parametrů (min. 0.162.0) a přihlaste se příkazem `codex login` přes ChatGPT.
   Přihlášení API klíčem se odmítá. Cestu lze nastavit v `providers.codex-cli.command` nebo proměnnou `FR_CODEX_CLI`.
   Windows používá nativní `codex.exe` (také z desktop aplikace); na Linuxu musí být CLI nainstalováno v daném prostředí.
2. Ověřte v nastavení účtu Codex, že nechcete používat placené kredity po vyčerpání limitu předplatného.
   V `config/fr.config.json` pak ručně doplňte:
   `billing.codex.creditUsageDisabledAttested: true`, `creditUsageAttestedBy` a `creditUsageAttestedAt`.
   Výchozí hodnota je false. Starší potvrzení Claude se na Codex nevztahuje; CLI samo stav kreditů neověří.
3. Spusťte `npm run preflight -- codex-cli` (Windows: `start.cmd preflight codex-cli`).
   Po úspěchu vyberte Codex CLI v aplikaci. Výchozí model `gpt-6.1-sol` lze změnit v `providers.codex-cli.model`.

Každé volání používá `codex exec --json --ephemeral --ignore-user-config --sandbox read-only`
v novém prázdném pracovním adresáři. API proměnné a vlastní CODEX_HOME se nepředávají, provider i ChatGPT režim
jsou vynucené. Shell, web, pluginy, aplikace, hooky, paměť, obrazové nástroje a subagenti jsou vypnutí.
Načítání projektových instrukcí i hostitelských skills je vypnuté. Prompt se předává pouze přes stdin.
Výstup, který obsahuje provedení nástroje, chybu, neplatné tokenové počty nebo chybějící dokončení, je odmítnut.

Tokeny a cache pocházejí z JSONL události turn.completed. Codex nezveřejňuje odhad USD v tomto výstupu,
proto zůstává null; fakturace se nevydává za ověřenou. Reálná inference nebyla součástí deterministických testů.

CLI reference: https://learn.chatgpt.com/docs/cli/reference
Non-interactive mode: https://learn.chatgpt.com/docs/non-interactive-mode

### Výběr modelu pro běh

Po výběru provideru vyberte v poli **Model** model pro daný běh. Claude: Sonnet 5.5, Opus 5.5 a Haiku 5.5.
Codex: GPT-6.1 Sol, GPT-6 Astra, GPT-6 Sol, GPT-6 Luna, GPT-5.6 Sol, GPT-5.6 Terra a GPT-5.6 Luna
(podle katalogu přihlášeného Codex CLI ověřeného 2026-10-09).
Fable 5.1 je uveden jako zakázaný, protože neinteraktivní Claude Code může účtovat usage credits bez dotazu.
Modely pouze pro přímé API nebo vyřazené z předplatného nejsou nabízeny.

Každý běh uchovává vybraný model v input.options.model a v telemetrii. Výběr jiného modelu nemění výchozí
model ani stav jiného běhu; pokračování po upřesnění zachovává původní model. Backend odmítá
modely mimo katalog provideru (BAD_MODEL), včetně Fable. Nedostupnost modelu v daném účtu je chyba CLI,
ne spouštěč placené náhradní cesty.

Katalog: src/providers/models.js.
Zdroje: https://code.claude.com/docs/en/model-config a https://learn.chatgpt.com/docs/models.
