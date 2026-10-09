# PASSPORT — FRANKENSTEIN (FR) v0.3.1

Předávací dokument pro navázání práce v nové relaci bez ztráty kontextu. Stav k **2026-10-09**.
Pravidlo pro čtenáře: co není výslovně označeno **OVĚŘENO**, je návrh nebo neověřený předpoklad.

---

## 1. Identita a stav

| Položka | Hodnota |
|---|---|
| Projekt | FRANKENSTEIN (FR) — samostatný univerzální agent, autonomní cyklus úlohy |
| Verze | **0.3.1** (`package.json`, UI, `run.frVersion`) |
| Repozitář | https://github.com/evymo/frankie (**veřejný**), větev `main` |
| Výchozí commit | `e657286` — „FRANKENSTEIN v0.3.1 — samostatný autonomní cyklus úlohy“ |
| Zadání (kanonické) | [`prompts/FRANKENSTEIN_v0.3_zadani.md`](../prompts/FRANKENSTEIN_v0.3_zadani.md) |
| Pracovní kopie | `G:\Můj disk\FRANKENSTEIN\frankenstein` (Google Drive) |
| Git data | `C:\Users\marti\.git-repos\frankie.git` (mimo Drive, `--separate-git-dir`) |
| Autor commitů | `Martin <273506629+MartinL68@users.noreply.github.com>` (repo-lokální config) |
| Stav | Funkční prototyp, celý cyklus ověřen mockem i reálnou inferencí (Sonnet 5.5 přes předplatné) |

Integrace s jinými platformami (AISHA, MCP guru apod.) v této etapě **záměrně není**. Starší dokumenty v
`G:\Můj disk\FRANKENSTEIN\*.md` popisují dřívější, integrovanou koncepci a nejsou součástí repozitáře.

---

## 2. Principy, které platí (a v0.3.1 je dodržuje)

1. **Algoritmy řídí, AI interpretuje a tvoří.** Pořadí kroků, limity, rozhodnutí A/B/C/D, kontrakty, kompilace promptu,
   deterministické kontroly a verdikt jsou kód. AI se volá jen pro: Gate 0, Goal Audit, porovnání cílů, exekuci,
   sémantickou verifikaci, volitelně baseline.
2. **Capabilities may grow; authority may not.** Schopnosti (H7) a oprávnění (H8) určuje `config/fr.config.json`,
   ne tvrzení modelu. Tvrzení AI se eviduje jako `aiClaim`.
3. **Fail-closed.** Co nelze ověřit, není PASS (UNVERIFIED). Neověřitelný fakturační režim = žádná reálná inference.
4. **Transparentní původ úsudku.** Každý štítek vztahu cílů nese `origin`: `algorithm`, `model`,
   `model+algorithm_consistency`, `algorithm_fallback`. Sémantický úsudek se nevydává za deterministický.
5. **Původní zadání je nedotknutelné.** Ukládá se beze změny (+ SHA-256), do promptů jde doslovně a ohraničené
   značkou odvozenou z hashe obsahu (nelze ji „uzavřít“ zevnitř).
6. **Simulace není důkaz.** Mock nikdy nevytvoří PASS (sémantický PASS z mocku → UNVERIFIED).
7. **Žádná API fakturace.** Jen Claude Code CLI s předplatným; žádný provider pro přímé API ani placený fallback.
8. **Jedna oprava.** Max. 1 řízený opravný průchod na větev, jen na základě konkrétních nesplněných kritérií,
   nikdy kvůli bezpečnostní kontrole nebo blokovaným operacím. Původní i opravený výsledek zůstávají evidovány.
9. **Žádné souběžné relace.** Server drží zámek — v jednom okamžiku nejvýše jeden běh (HTTP 409).

---

## 3. Architektura

```
src/core/pipeline.js       FR Core — stavový automat (tabulka TRANSITIONS), limity, zámek RunManager, orchestrace
src/core/gate0.js          Gate 0 — 1 AI volání H1–H10; ověření citací; H7/H8 z konfigurace; detektory → minimální priority
src/core/detectors.js      explicitní cíl (pole > „Cíl:“ v promptu), prompt injection, citlivá data, operace mimo oprávnění (regex)
src/core/goalAudit.js      Goal Audit (izolované volání bez H1) + plán porovnání + slučování s konzistenčním pravidlem
src/core/decision.js       rozhodovací tabulka RULES (čistá funkce) + deterministické upřesňující otázky
src/core/goalContract.js   Goal Contract: deep-frozen, SHA-256 hash obsahu, reviseContract() = nová verze
src/core/criteria.js       validace návrhů kritérií (neplatné → sémantické s důvodem), deterministické kontroly, SYS-1..4
src/core/promptCompiler.js Execution Contract a opravný prompt — deterministicky, bez AI, verzované šablony
src/core/executor.js       deterministický nástroj (pokud plně řeší úlohu) → jinak AI přes provider
src/core/verifier.js       verifikace po kritériích, computeVerdict(), evidenceSupported(), repairDecision()
src/core/telemetry.js      volání, tokeny, cache, časy (AI vs. algoritmus), odhad USD, ověřená fakturace = NEOVĚŘENO
src/core/store.js          JSON záznam běhu v data/runs (atomický zápis); po restartu nedokončené → FAILED/INTERRUPTED
src/tools/                 arith_eval, csv_to_json, text_stats, jsSandbox (node --permission, timeout, statický zákaz)
src/providers/mock.js      deterministická simulace AI (+ skriptované odpovědi pro testy)
src/providers/claudeCli.js Claude Code CLI provider (výchozí model claude-sonnet-5-5)
src/providers/preflight.js bezpečnostní preflight fakturace (fail-closed)
src/providers/cliEnv.js    vyhledání CLI + whitelist prostředí pro podřízený proces
src/templates/             verzované šablony analytických volání
src/server.js              HTTP API jen na 127.0.0.1 (+ kontrola Host/Origin, CSP)
public/                    frontend (HTML/CSS/JS bez závislostí)
test/                      72 deterministických testů (node:test), fixtures/fake-claude.js
```

### Stavový automat
`RECEIVED → GATE0 → GOAL_AUDIT → GOAL_COMPARE → DECISION → (CLARIFICATION_REQUIRED | CONTRACTS →
[COMPILE → EXECUTE → VERIFY → (REPAIR → VERIFY)] × větev → (BASELINE) → REPORT → DONE)`; chyba → `FAILED`.

### Rozhodovací tabulka (bez procent a prahů)
| Pravidlo | Podmínka | Výsledek |
|---|---|---|
| A1 | bez explicitního cíle; audit odvoditelný, jistota ≥ medium; H1↔audit EQUIVALENT/NONCRITICAL | A — 1 kontrakt (základ: audit) |
| A2 | bez explicitního cíle; audit neodvoditelný nebo jistota low | A — STOP / CLARIFICATION |
| A3 | bez explicitního cíle; H1↔audit CRITICAL/UNCLEAR | D |
| D1 | explicitní cíl; explicit↔audit nebo explicit↔H1 CRITICAL/UNCLEAR | D — STOP + otázka na rozpor |
| B1 | explicitní cíl; oba vztahy EQUIVALENT | B — 1 sjednocený kontrakt |
| C1 | explicitní cíl; ≥1 NONCRITICAL, žádný kritický | C — 2 větve; primární = explicitní cíl (vyšší autorita) |

Pokračování po STOP: nový navazující běh (`parentRunId`), původní prompt beze změny, otázka+odpověď v `clarifications`.
Bez nového explicitního cíle se původní (rozporný) **nepřebírá** — eviduje se v `previousExplicitGoal`.

### Kritéria a verdikt
- Typy kontrol: `nonempty, json_valid, json_schema, json_equals, contains, not_contains, regex, number_equals,
  max_words, min_words, code_artifact_present, js_function_tests, semantic` + systémové `no_blocked_claims`, `blocked_scope`.
- Systémová kritéria: **SYS-1** neprázdný výstup; **SYS-2** nevykazuje splnění blokovaných operací (i textové
  tvrzení typu „e-mail byl odeslán“); **SYS-3** formát (JSON/kód); **SYS-4** zadání bez blokovaných částí (neopravitelné).
- **GOAL-1** (sémantické, povinné): výsledek naplňuje cíl kontraktu. **TOOL-1**: shoda s deterministickým nástrojem.
- Verdikt (jen povinná kritéria): vše PASS → **PASS**; žádný FAIL, ale něco neověřeno → **UNVERIFIED**;
  FAIL + něco PASS → **PARTIAL**; jinak **FAIL**.
- Sémantický PASS je přijat jen, když je citace doslovně ve výstupu, nebo jsou ve výstupu **všechny** citace v uvozovkách.

### Verze šablon
`gate0@1.0.0`, `goal-audit@1.0.0`, `goal-compare@1.0.0`, `semantic-verify@1.1.0` (dostává původní zadání),
`baseline@1.0.0`, `execution-contract@1.0.0`, `execution-repair@1.0.0`.

---

## 4. Ochrana fakturace (§13 zadání)

Preflight (`start.cmd preflight`, také před každým reálným během) — vše musí být PASS/WARN:
CLI nalezeno (nativní `.exe`) · verze ≥ 2.1.0 · podporované izolační parametry · `claude auth status` v čistém prostředí:
`loggedIn=true`, `authMethod` = předplatné (`claude.ai`), `apiProvider=firstParty` · žádné API proměnné (do CLI se stejně
nepředávají) · v nastavení Claude Code žádný `apiKeyHelper`/API env · **extra usage potvrzena člověkem** · limity.

Každé volání: nový proces, `-p --output-format json --model claude-sonnet-5-5 --tools "" --safe-mode --strict-mcp-config
--no-session-persistence --disable-slash-commands --permission-prompts none --system-prompt <šablona>`, prázdný pracovní
adresář v `%TEMP%\fr-cli-sandbox`, **prompt jen přes stdin**, prostředí jen z whitelistu. `--bare` se nepoužívá (vynucuje API klíč).

Aktuální stav (OVĚŘENO preflightem 2026-10-09): předplatné **Pro**, `claude.ai`, firstParty, CLI 2.1.293 přibalené k desktop
aplikaci (`%APPDATA%\Claude\claude-code\2.1.293\…\claude.exe` — cesta se mění s aktualizací). Extra usage: potvrzeno
uživatelem v `config/fr.config.json` (`extraUsageDisabledAttested: true`, 2026-10-09).

---

## 5. Co je ověřeno

**Testy (OVĚŘENO): 72/72** — 10 reportových struktur, priority a algoritmické úpravy, explicitní cíl, A1/A2/A3/B1/C1/D1,
porovnání a původ, Goal Contract (neměnnost, hash, revize), Prompt Compiler (determinismus, originál doslovně, ohraničení,
fakta vs. předpoklady), deterministické kontroly, sandbox (timeout, izolace), verdikty, max. 1 oprava, SYS-2/SYS-4,
prompt injection, telemetrie, blokace API (preflight, whitelist prostředí, falešné CLI, registr providerů),
HTTP API (zámek 409, export, znovuotevření bez inference, Host/Origin), 14 E2E scénářů s mockem.

**Frontend (OVĚŘENO v prohlížeči):** odpověď FR nahoře, stav C, D + pokračování, mobilní šířka, stažení HTML artefaktu.

### Reálné běhy (Sonnet 5.5 přes předplatné)

| Běh | Zadání | Rozhodnutí | Verdikt | Volání | Čas | USD odhad |
|---|---|---|---|---|---|---|
| …012224-56afb4 | Vypočítej (17*23+5)/2 a vysvětli postup | A1 | PASS | 5 | 45,9 s | 0,101 |
| …012312-7d180c | funkce isPrime (13/13 testů v sandboxu) | A1 | PASS | 5 | 55,1 s | 0,119 |
| …012409-dc15e8 | shrnutí ≤ 40 slov (před opravou hodnotitele) | A1 | UNVERIFIED | 5 | 56,3 s | 0,120 |
| …012853-27322b | totéž po opravě (semantic-verify@1.1.0) | A1 | PASS | 5 | 50,8 s | 0,114 |
| …014003, …014241 | „Chci zachránit svět a světový mír.“ | A2 STOP | — | 3+3 | ~50 s | 0,085+0,086 |
| …014615-19f426 | webová hra Člověče nezlob se (explicitní cíl: spustitelná HTML aplikace) | C1 | B1 PARTIAL (SYS-4), B2 přerušeno | 7 | 222 s | 0,495 |
| …021132-c5eb16 | Ověř, kolik je hodin v San Franciscu | A1 | PARTIAL | 5 | 67,2 s | 0,133 |
| …021652, …021816 | „How do you do expert ?“ | A2 STOP | — | 3+3 | ~49 s | 0,079+0,086 |
| …022030-5b03c6 | popiš tento projekt čtyřmi větami | A1 | PARTIAL | 5 | 57,6 s | 0,114 |

**Součet:** 11 reálných běhů, **49 volání**, odhad ekvivalentu **≈ $1,53** (+ 1 neplánované testovací volání
„Řekni ahoj.“, $0,0027). Skutečná fakturace: **NEOVĚŘENO** (z CLI nezjistitelné). Typicky ~10 s na volání,
~50–60 s na běh, algoritmická část < 1 s. Historie běhů je jen lokálně v `data/runs/` (není v repozitáři).

---

## 6. Známé vady a zjištění (vstup pro další fázi)

1. **SYS-4 je příliš přísné.** Operace, kterou si model v Gate 0 „vymyslí“ (např. „zapsat soubory do pracovního
   adresáře“ u HTML hry), shodí verdikt na PARTIAL, i když ji uživatel nepožadoval. Návrh: blokovaná operace ovlivní
   verdikt jen s doslovnou oporou v zadání nebo z deterministického detektoru.
2. **Chybí kontext a vstupy.** „Popiš tento projekt“ → FR nemá přístup k souborům ani k vlastní dokumentaci → PARTIAL.
   Rozhodnout model kontextu: přiložené soubory, čtení povolených cest (read-only), self-knowledge.
3. **Reálný čas a web** („kolik je hodin v SF“) → poctivě PARTIAL (realtime_data/web_access vypnuto). Chování správné,
   ale chybí nástroj (deterministické hodiny/časová pásma by úlohu vyřešily bez AI).
4. **Přehnané upřesňování a jazyk.** „How do you do expert?“ → STOP s otázkou v češtině, ačkoli uživatel psal anglicky
   a šlo spíše o konverzaci. Chybí rychlá cesta pro konverzační/triviální zadání a volba jazyka odpovědi podle uživatele.
5. **Cena analýzy vs. exekuce.** STOP stojí 3 volání (~$0,08, ~50 s); každý běh má ~4 režijní volání. Možnosti:
   souběh Gate 0 ∥ Goal Audit, vynechání porovnání při algoritmické shodě, vynechání sémantické verifikace,
   když jsou povinná kritéria deterministická, „lehký režim“ pro jednoduché úlohy.
6. **Sandbox JS** neblokuje síť (Node 24 permission model), jen staticky zakazuje konstrukce. Není to bezpečnostní hranice.
7. **Detektory** (injection, PII, operace) jsou hrubé regexy — falešné pozitivy i negativy.
8. **Mock** zná jen omezenou sadu úloh; slouží k testu toku, ne kvality.
9. **Prostředí:** Node.js není nainstalován (běží Node v24 z aplikace Codex — `FR_NODE`); CLI je přibalené k desktop aplikaci.
10. **Provozní lekce:** restart serveru během běhu běh přeruší (stalo se 2026-10-09 u „Člověče nezlob se“) —
    před restartem kontrolovat `GET /api/status` → `busy`.

---

## 7. Doporučení pro v0.4 (návrh, neschváleno)

- Principy kontextu: co smí FR číst (soubory, URL, vlastní dokumentace), jak se to eviduje jako ověřený fakt.
- Nástrojová vrstva: registry deterministických nástrojů (čas/pásma, jednotky, datumy, regex, JSON transformace),
  pravidla „nástroj před AI“.
- Kalibrace verdiktu: SYS-4 jen s doložením, váhy volitelných kritérií, lidsky čitelné zdůvodnění verdiktu.
- Úspora: paralelizace analytických volání, adaptivní hloubka (lehký / plný cyklus), cache analytických výsledků.
- Jazyk: odpověď i otázky v jazyce uživatele.
- Experiment BASELINE vs. FR na sadě úloh (kvalita, cena, čas).
- Plnohodnotný sandbox (proces bez sítě), instalace Node 22+ a CI (GitHub Actions s `npm test`).

---

## 8. Jak spustit

```bash
set FR_NODE=C:\Users\marti\AppData\Local\OpenAI\Codex\runtimes\cua_node\3dd31cfff853001c\bin\node.exe
start.cmd              # server http://127.0.0.1:4173
start.cmd test         # 72 testů, bez AI
start.cmd preflight    # kontrola předplatitelského režimu, bez inference
```
V UI: Provider „Mock“ = simulace zdarma; „Claude CLI — claude-sonnet-5-5“ = reálná inference (~5 volání na běh).

---

## 9. Pravidla spolupráce (dohodnutá)

- Komunikace, reporty a UI česky.
- Reálná inference jen se souhlasem uživatele; nikdy ad-hoc `claude -p` mimo pojistku FR.
- Před restartem serveru zkontrolovat, zda neběží uživatelův běh.
- Repozitář je veřejný — žádná tajemství, osobní údaje ani data běhů.
- Git: commit a push na `main` (přihlášení uloženo v Git Credential Manageru); git data mimo Google Drive.
- Nežádat souhlas s běžnými implementačními detaily; eskalovat jen zásadní rozhodnutí, bezpečnost a fakturaci.
