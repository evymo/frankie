# FRANKENSTEIN v0.4 — autonomní cyklus úlohy s adaptivním učením hledisek

Lokální prototyp agenta (FR), který zadání nejdřív **pochopí a zamkne**, a teprve potom ho nechá vykonat a **ověří**.
Zadání analyzuje podle deseti hledisek, nezávisle audituje cíl, rozhodne podle pravidel A/B/C/D, vytvoří neměnný
Goal Contract, algoritmicky sestaví exekuční prompt, převezme výsledek, ověří ho proti akceptačním kritériím a vykáže
telemetrii. Od v0.4 se navíc učí, kterou sestavu hledisek použít, ze zkušeností sdílených v Gitu.

**Princip:** algoritmy řídí, AI interpretuje a tvoří. *Capabilities may grow; authority may not.*

- Node.js 22+, **žádné npm závislosti**, server jen na `127.0.0.1`.
- Reálná inference jen přes **předplatné** (Claude Code CLI nebo Codex CLI). Přímé API ani placený fallback neexistuje.
- Bez přihlášení funguje vše na deterministickém **mocku** (simulace, nulové náklady).

## Obsah

[Co umí](#co-umí) · [Jak pustit](#jak-pustit) · [Reálná inference](#reálná-inference) · [HTTP API](#http-api) ·
[Benchmark](#benchmark-bench) · [Učení](#učení-v04) · [Architektura](#architektura) · [Známá omezení](#známá-omezení) ·
[Dokumentace](#dokumentace)

## Co umí

| Oblast | Co FR dělá |
|---|---|
| **Porozumění zadání** | Profil zadání bez AI → Gate 0 (1 AI volání) pro hlediska H1–H10 s ověřením citací → nezávislý audit cíle (izolované volání bez H1) → porovnání s evidencí původu. |
| **Rozhodnutí** | Rozhodovací tabulka A1/A2/A3/D1/B1/C1 (čistá funkce). Když zadání nejde splnit bezpečně nebo jednoznačně, FR se **doptá** (stav `CLARIFICATION_REQUIRED`) a na odpověď naváže dalším během. |
| **Goal Contract** | Neměnný, hashovaný a verzovaný kontrakt cíle s akceptačními kritérii; revize = nová verze. |
| **Exekuce** | Deterministický nástroj, pokud stačí (`arith_eval`, `csv_to_json`, `text_stats`, JS sandbox přes `node --permission`), jinak AI přes provider. Prompt sestaví **Prompt Compiler** deterministicky z verzovaných šablon, bez AI. |
| **Ověření** | Kritéria se kontrolují deterministicky, v sandboxu nebo sémanticky. Výsledkem je verdikt `PASS / PARTIAL / FAIL / UNVERIFIED` a nejvýš 1 oprava. Volitelně baseline (stejný model bez FR) pro srovnání. |
| **Bezpečnost** | Detektory prompt injection, citlivých dat a operací mimo oprávnění (regex). H7/H8 z konfigurace. Stropy počtu volání a oprav nezávislé na konfiguraci. Běží jen 1 běh najednou. |
| **Učení (v0.4)** | Volba sestavy hledisek (H-sestavy) podle doložených zkušeností, diagnóza odchylek, kandidátní změny a řízené experimenty proti témuž zamčenému kontraktu. Viz [Učení](#učení-v04). |
| **Telemetrie** | Volání, tokeny, cache, čas AI × algoritmus, odhad USD vs. ověřená fakturace, zvolený model. |
| **UI** | Živý průběh, modře odlišená hlavní odpověď, přepínač **Provozní / Detailní**, historie běhů, export běhu do JSON, stažení kompilovaného promptu, dialog preflightu a Knowledge Base. |
| **Benchmark** | `bench/`: FR × samostatný dotaz na tentýž model nad vlastními modely (vLLM/GPU, Ollama, AISHA /v1) s nezávislým oráklem. |

**Typický počet modelových volání na běh:** Gate 0 (1) + audit (1) + porovnání (0–1) + exekuce (0–1 na větev)
+ sémantická verifikace (0–1 na větev a pokus) + oprava (0–2). Profil, výběr H-sestavy, diagnóza a aktualizace znalostí
jsou bez AI volání. Typicky 4–5 volání, ve stavu C 7, strop 14 (`limits.maxModelCallsPerRun`). Řízený experiment: 3–5 volání.

## Jak pustit

Požadavky: **Node.js 22+**. Pro reálnou inferenci navíc Claude Code CLI s předplatným nebo Codex CLI s přihlášením
ChatGPT (viz [Reálná inference](#reálná-inference)). Bez nich běží mock.

**macOS / Linux**

```bash
npm start
```

Server poběží na http://127.0.0.1:4173. Další příkazy:

```bash
npm test                          # deterministické testy jádra i bench/ (bez AI a bez sítě)
npm run preflight                 # kontrola předplatitelského režimu Claude CLI (bez inference)
npm run preflight -- codex-cli    # totéž pro Codex CLI
FR_PORT=4174 npm start            # jiný port (např. když 4173 už něco drží)
```

**Windows**

```bat
start.cmd             # server na http://127.0.0.1:4173
start.cmd test        # deterministické testy (bez AI)
start.cmd preflight   # kontrola předplatitelského režimu CLI (bez inference)
start.cmd preflight codex-cli
```

Pokud `node` není v PATH, nastavte `set FR_NODE=C:\cesta\k\node.exe`.

**První běh:** v levém panelu zadejte např. `Vypočítej (17*23+5)/2`, nechte provider **Mock** a klikněte **Spustit**.
Uvidíte celý cyklus včetně Goal Contractu a verifikace. Odpověď mocku je zástupná a verdikt zůstane `UNVERIFIED`,
protože simulace se za ověřenou odpověď nevydává. Pro skutečnou odpověď vyberte ověřený provider a model.

### Proměnné prostředí

| Proměnná | Význam |
|---|---|
| `FR_PORT` | Port serveru (výchozí `server.port` z konfigurace = 4173). |
| `FR_CONFIG` | Cesta k jinému konfiguračnímu souboru (výchozí `config/fr.config.json`). |
| `FR_KNOWLEDGE_DIR` | Jiný adresář Knowledge Base (výchozí `knowledge/` v repozitáři), např. pro pokusy, které nemají jít do Gitu. |
| `FR_CLAUDE_CLI` / `FR_CODEX_CLI` | Cesta ke Claude Code CLI / Codex CLI, pokud nejsou v PATH. |
| `FR_NODE` | Cesta k `node.exe` pro `start.cmd` (Windows). |

Data běhů se ukládají do `data/runs` (mimo Git). Po pádu serveru se nedokončený běh při startu označí `INTERRUPTED`.

## Reálná inference

Ve výchozím stavu je **zablokovaná**. Každý CLI provider má vlastní preflight (bez inference), který běží při startu
serveru a lze ho zopakovat v dialogu providerů (klik na pilulku vpravo nahoře). Když preflight neprojde, běh skončí
ve stavu `FAILED/BILLING_GUARD` bez jediného volání a mock zůstává dostupný. Žádný automatický přechod mezi providery
ani přímé API se nepoužívá.

### Claude (Claude Code CLI s předplatným)

Preflight musí projít všemi kontrolami:

1. CLI je nalezeno (konfigurace → `FR_CLAUDE_CLI` → PATH → `~/.local/bin` → CLI přibalené k desktop aplikaci).
2. `claude auth status` v čistém prostředí: `loggedIn=true`, metoda `claude.ai` (předplatné), `apiProvider=firstParty`.
3. V nastavení Claude Code není `apiKeyHelper` ani API proměnné.
4. **Ručně:** v claude.ai → Settings → Usage ověřte, že placená *extra usage* je vypnutá, a v
   `config/fr.config.json` nastavte `billing.extraUsageDisabledAttested: true`, `extraUsageAttestedBy`, `extraUsageAttestedAt`.
   Z CLI to ověřit nelze, proto je nutné potvrzení člověkem. **Potvrzení zapsané v repozitáři platí jen pro účet toho,
   kdo ho zapsal.** Na jiném účtu ho ověřte a přepište sami.

Každé volání: nový proces, `--safe-mode` (bez CLAUDE.md, hooků, pluginů, MCP), žádné nástroje, prázdný pracovní adresář,
prompt jen přes stdin.

### Codex (Codex CLI s přihlášením ChatGPT)

1. Nainstalujte Codex CLI s podporou izolačních parametrů (min. **0.162.0**) a přihlaste se příkazem `codex login` přes
   ChatGPT. Přihlášení API klíčem se odmítá. Cestu lze nastavit v `providers.codex-cli.command` nebo `FR_CODEX_CLI`.
   Windows používá nativní `codex.exe` (také z desktop aplikace). Na Linuxu musí být CLI nainstalováno v daném prostředí.
2. V nastavení účtu Codex ověřte, že nechcete používat placené kredity po vyčerpání limitu předplatného, a v
   `config/fr.config.json` doplňte `billing.codex.creditUsageDisabledAttested: true`, `creditUsageAttestedBy` a
   `creditUsageAttestedAt`. Starší potvrzení Claude se na Codex nevztahuje.
3. `npm run preflight -- codex-cli` (Windows: `start.cmd preflight codex-cli`), pak vyberte Codex CLI v aplikaci.

Každé volání: `codex exec --json --ephemeral --ignore-user-config --sandbox read-only` v novém prázdném adresáři.
Shell, web, pluginy, hooky, paměť, obrazové nástroje i subagenti jsou vypnutí, prompt jde jen přes stdin. Výstup s
provedením nástroje, chybou, neplatnými tokeny nebo bez dokončení se odmítne. Tokeny a cache jsou z události
`turn.completed`. Odhad USD Codex nezveřejňuje, proto zůstává `null` a fakturace se nevydává za ověřenou.

### Výběr modelu pro běh

Po výběru provideru zvolte v poli **Model** model pro daný běh:

- **Claude:** Sonnet 5.5, Opus 5.5, Haiku 5.5. Fable 5.1 je zakázaný, protože neinteraktivní Claude Code může účtovat
  usage credits bez dotazu.
- **Codex:** GPT-6.1 Sol (výchozí), GPT-6 Astra, GPT-6 Sol, GPT-6 Luna, GPT-5.6 Sol, GPT-5.6 Terra, GPT-5.6 Luna
  (katalog přihlášeného Codex CLI ověřený 2026-10-09).

Vybraný model se uloží v `input.options.model` a v telemetrii. Pokračování po upřesnění zachová původní model. Backend
odmítá modely mimo katalog provideru (`BAD_MODEL`), včetně Fable. Katalog vestavěných CLI má přednost i před seznamem,
který by provider nabídl sám. Katalog: [`src/providers/models.js`](src/providers/models.js).
Zdroje: https://code.claude.com/docs/en/model-config, https://learn.chatgpt.com/docs/models,
https://learn.chatgpt.com/docs/cli/reference.

## HTTP API

UI je jen klient lokálního JSON API. Totéž API můžete volat přímo (skripty, testy, jiný frontend).

| Metoda a cesta | Co dělá |
|---|---|
| `GET /api/status` | Verze, providery s katalogem modelů, výsledky preflightů, probíhající běh, limity, hlediska, pravidla rozhodování, stav učení a KB. |
| `POST /api/preflight` | `{ "provider": "claude-cli" \| "codex-cli" }` — znovu spustí preflight (bez inference). |
| `GET /api/runs` | Seznam běhů (stav, provider, rozhodnutí, verdikty, náhled zadání). |
| `POST /api/runs` | Spustí běh → `202 { id, state }`. Tělo: `prompt`, volitelně `explicitGoal`, `provider`, `model`, `baseline`, `learningMode` (`auto` / `default`). Navázání po upřesnění: `parentRunId` + `clarificationAnswer`. |
| `GET /api/runs/:id` | Kompletní záznam běhu (události průběhu, kontrakty, větve, verifikace, report, telemetrie). |
| `GET /api/runs/:id/export` | Totéž jako soubor ke stažení (`<id>.json`). |
| `GET /api/runs/:id/prompt/:větev/:pokus` | Kompilovaný systémový a uživatelský prompt daného pokusu (Markdown). |
| `GET /api/kb` | Souhrn Knowledge Base (sestavy, doporučení, stavy důvěryhodnosti). |
| `POST /api/experiments` | Řízený experiment H-sestavy: `baseRunId`, `recommendationId`, `provider`, `confirmRealCalls`. |

Příklad (mock, bez nákladů):

```bash
curl -s -X POST http://127.0.0.1:4173/api/runs \
  -H 'Content-Type: application/json' -H 'Origin: http://127.0.0.1:4173' \
  -d '{"prompt":"Spočítej 12*23","provider":"mock"}'
```

Odpověď je `{"id":"RUN-…","state":"…"}`. Stav se pak čte přes `GET /api/runs/RUN-…`, hotový běh má `state: "DONE"`
a v `report` najdete `primaryVerdict`, `decision` a `realityNote`.

Ochrana: server poslouchá jen na `127.0.0.1`, přijímá jen `Host` localhost (proti DNS rebinding) a u zápisů vyžaduje
`application/json` a stejný `Origin` (jiný → 403). Chyby: `409 BUSY` (už běží jiný běh), `400` pro `BAD_INPUT`,
`BAD_PROVIDER`, `BAD_MODEL`, `BAD_PARENT`, `BAD_EXPERIMENT`.

## Benchmark (`bench/`)

Integrační harness **FR × samostatný dotaz na tentýž model**, který žije mimo kód FR: `src/` z `bench/` nic neimportuje
a nenese adresu ani klíč lane. Provider se do `runPipeline` vkládá zvenku. Podrobnosti: [`bench/README.md`](bench/README.md).

```bash
cp bench/backends.example.json bench/backends.json   # lokální (v .gitignore): adresy a modely backendů
node bench/run.js --only gpu-qwen                     # benchmark → data/bench/<čas>/
node bench/report.js data/bench/<čas>                 # report běhu
node bench/serve.js --port 4174                       # UI FR navíc s modely z bench/backends.json
```

- `openaiCompat.js` je adaptér pro vLLM, Ollama, Docker Model Runner i AISHA /v1. **K9 (soudce ≠ vykonavatel) je
  vynucené:** bez nezávislého soudce (jiný `root` vah) preflight neprojde. Chybějící `root` znamená, že nezávislost
  nejde ověřit, a preflight také neprojde. Výjimka je možná jen výslovně (`allowSameJudge`), evidence pak nese `k9: false`.
- Správnost hodnotí **nezávislý orákl** (`oracle.js`, předem známé odpovědi, jen deterministické kontroly), ne verdikt FR.

**Výsledky (FR v0.3.1, 2026-10-09):** na této sadě FR sám o sobě lepší výsledky **nedal**. Sonnet 12/12 : 12/12, vlastní
Qwen 10/12 : 12/12 při ~5 voláních a ~30–45× více tokenech. Princip učení z chyby funguje (řízené chyby 3/3), brzdí
ho vrstva ověřování. Nálezy a doporučení: [`docs/BENCH-2026-10-09.md`](docs/BENCH-2026-10-09.md). Na v0.4 je potřeba
měřit znovu.

**Pravidla:** Sonnet přes `claude-cli` jen jako ruční kalibrace vlastníkem účtu, nejvýš 20 volání (§5a). Benchmarky se
dělají jen na vlastních modelech. GPU hostitel je sdílený, okno je potřeba domluvit předem. Adresy a klíče patří jen
do lokálního `bench/backends.json` a proměnných prostředí, nikdy do repa.

## Učení (v0.4)

FR určí charakteristiku zadání (bez AI), podle doložených zkušeností ze sdílené Knowledge Base zvolí H-sestavu,
diagnostikuje odchylky (oprávnění / vstupy / exekuce / hodnotitel / strategie), navrhuje kandidátní změny sestavy a ověřuje
je řízeným srovnáním proti témuž zamčenému Goal Contractu. Aktivně se použije jen opakovaně ověřená zkušenost.
Systémové garance H1/H7/H8/H9 se nikdy neučí.

- Knowledge Base je **sdílená v repozitáři** v [`knowledge/`](knowledge/README.md), jeden soubor na záznam, append-only,
  týmová práce přes `git pull/push`. Obsahuje jen metodu, ne texty zadání, výstupy ani hash zadání. Plné běhy
  (`data/runs`) zůstávají mimo Git.
- Simulované (mock) experimenty jsou povolené vždy a do důvěryhodnosti se nezapočítávají.
- Reálný experiment (3–5 volání) vyžaduje `learning.realExperiments.enabled: true` v `config/fr.config.json` **a**
  potvrzení v UI. Platí denní limit `maxPerDay`. Ve výchozím stavu je vypnutý.
- Pro jeden běh lze vynutit výchozí sestavu zaškrtnutím „Výchozí H-sestava“.
- Redukce hledisek z reálných běhů je do M-FR1 jen pro ladění (viz [Známá omezení](#známá-omezení)).

Kvalitativní účinnost H-sestav na reálném modelu **zatím čeká na ověření** reálnými experimenty.

## Architektura

```
src/server.js              lokální HTTP server + JSON API (jen 127.0.0.1)
src/core/pipeline.js       FR Core — stavový automat, limity, zámek 1 běhu, orchestrace, události průběhu (run.events)
src/core/profile.js        charakteristika zadání (bez AI) a kvalitativní shoda profilů
src/core/aspectSets.js     verzované H-sestavy; invarianty systémových garancí H1/H7/H8/H9
src/core/knowledge.js      sdílená Knowledge Base (knowledge/, append-only), výběr sestavy, stavy důvěryhodnosti
src/core/learning.js       diagnóza příčin, kandidátní hypotézy, řízené srovnání
src/core/evaluator.js      verze hodnotitele s historií (SYS-4 1.1.0)
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
src/providers/             mock (simulace), claude-cli a codex-cli (předplatné) + preflight, katalog modelů, čisté prostředí
src/templates/             verzované šablony analytických volání
src/cli/preflight.js       preflight z příkazové řádky
public/                    frontend (HTML/CSS/JS bez závislostí)
config/fr.config.json      providery, limity, oprávnění, billing potvrzení, učení
knowledge/                 sdílená Knowledge Base (fr-kb/2)
bench/                     benchmark a harness mimo kód FR
test/                      deterministické testy (node:test)
```

Stavový automat: `RECEIVED → PROFILE → GATE0 → GOAL_AUDIT → GOAL_COMPARE → DECISION → (CLARIFICATION_REQUIRED | CONTRACTS →
[COMPILE → EXECUTE → VERIFY → (REPAIR → VERIFY)] × větve → (BASELINE) → REPORT → LEARN → DONE)`.
Řízený experiment H-sestavy: `RECEIVED → PROFILE → GATE0 → CONTRACTS (zamčený z původního běhu) → … → LEARN → DONE`.

Report běhu nese `realityNote`, který dodává sám provider (`describe().note`): mock = simulace, Claude/Codex = reálná
inference. Jádro podle backendu nevětví.

## Známá omezení

- Mock jen simuluje odpovědi modelu. Algoritmické části (stavový automat, rozhodnutí, kompilace promptu, nástroje,
  kontroly, sandbox) ale běží reálně.
- Sandbox JS není plnohodnotná bezpečnostní hranice: síť v permission modelu Node 24 neomezuje, je jen staticky zakázaná.
- Deterministické detektory jsou hrubé (regex).
- Placenou extra usage / kredity nelze ověřit strojově, potvrzuje je člověk.
- Kvalitativní přínos H-sestav na reálném modelu zatím není ověřený. Benchmark na v0.3.1 přínos samotného FR na své
  sadě neprokázal (viz [Benchmark](#benchmark-bench)). Čísla v `docs/BENCH-2026-10-09.md` jsou z v0.3.1.
- **Učení redukcí je do M-FR1 jen pro ladění.** Kód navrhne redukci hledisek z každého reálného běhu, kde vše vyšlo
  PASS (`src/core/learning.js`). Zatím neověřuje, že PASS stojí na deterministickém důkazu nebo na nezávislé kontrole
  (soudce ≠ vykonavatel). Na v0.4 je doložené, že se smyčka učila z falešného PASS (gpu-qwen, S01: 201 → PASS →
  hypotéza „odebrat H10“). Návrh se uloží jen jako kandidát. Aktivní se může stát až po nejméně 2 reálných řízených
  srovnáních, a reálné experimenty jsou ve výchozí konfiguraci vypnuté. Reálné experimenty proto nezapínejte kvůli
  ověřování redukcí, dokud M-FR1 tuto podmínku nedoplní do kódu.
- Výsledek deterministického výpočtu (`arith_eval`) je povinné kritérium vždy, takže chybné číslo nikdy neprojde jako
  PASS. Nástroj ale zatím nemá veto: když ostatní povinná kritéria projdou, vyjde `PARTIAL` (spustí opravu), ne `FAIL`.
  U `csv_to_json` je převod povinný jen při úplném řešení, protože u filtrování je úplný převod jen mezikrok.
- Číselná kontrola (`number_equals`) bere **poslední číslo** výstupu. Odpověď, která uvede výsledek před postupem,
  proto může neprojít i se správným výsledkem.

## Dokumentace

- Zadání: [`prompts/`](prompts/README.md) (prompts-as-repo, aktuálně
  [v0.4](prompts/FRANKENSTEIN_v0.4_adaptive_h_learning_ui_CC.md), dříve [v0.3](prompts/FRANKENSTEIN_v0.3_zadani.md))
- Architektura a principy v0.4: [`docs/ARCHITEKTURA-v0.4.md`](docs/ARCHITEKTURA-v0.4.md)
- Výchozí stav v0.3.1, reálné běhy a známé vady: [`docs/PASSPORT-v0.3.1.md`](docs/PASSPORT-v0.3.1.md)
- Benchmark 2026-10-09: [`docs/BENCH-2026-10-09.md`](docs/BENCH-2026-10-09.md), harness: [`bench/README.md`](bench/README.md)
- Knowledge Base: [`knowledge/README.md`](knowledge/README.md)
- Prezentace (90 s): [`docs/prezentace/FRANKENSTEIN_v0.4_Aisha_90s.pptx`](docs/prezentace/FRANKENSTEIN_v0.4_Aisha_90s.pptx)
