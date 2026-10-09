# FRANKENSTEIN v0.4 — Adaptivní učení analytických hledisek (H-learning)

Stav k **2026-10-09**. Navazuje na [PASSPORT v0.3.1](PASSPORT-v0.3.1.md). Kanonické zadání:
[`prompts/FRANKENSTEIN_v0.4_adaptive_h_learning_ui_CC.md`](../prompts/FRANKENSTEIN_v0.4_adaptive_h_learning_ui_CC.md).

Pravidlo pro čtenáře: **OVĚŘENO** = prokázáno deterministickými testy nebo v prohlížeči. **ČEKÁ NA OVĚŘENÍ** = vyžaduje
reálnou inferenci, kterou zatím nikdo neautorizoval. Mock dokládá jen **tok** mechanismu, nikdy kvalitu modelu.

---

## 1. Co v0.4 přináší (stručně)

| Oblast | Výsledek | Stav |
|---|---|---|
| Profil zadání (bez AI) | kategorická charakteristika: povaha, artefakt, jazyk, omezení, kontext, ověřitelnost, schopnosti, rizika | OVĚŘENO testy |
| H-sestavy | verzované, hashované kombinace hledisek; systémové garance H1/H7/H8/H9 nelze odebrat ani oslabit | OVĚŘENO testy |
| Výběr sestavy | z lokální Knowledge Base; aktivně jen **ověřená** zkušenost se silnou shodou charakteristiky | OVĚŘENO testy (na syntetické fixture KB) |
| Vliv na prompt | sestava mění otázky Gate 0 a sekci priorit Execution Contract; stopa `aspectTrace` | OVĚŘENO testy |
| Diagnóza | 7 tříd příčin; H-sestavě se připisuje jen „interpretace / analytická strategie“ | OVĚŘENO testy |
| Hypotézy | kandidátní změna sestavy (1 změna), z katalogu HX-*; redukce jen z reálného úspěchu | OVĚŘENO testy |
| Řízený experiment | stejný prompt, **zamčený** Goal Contract (ověřený hash), stejná kritéria, hodnotitel i šablony | OVĚŘENO testy a v UI (mock) |
| Důvěryhodnost | kandidát → podpořeno (1 reálné srovnání) → ověřeno (≥ 2) / sporné / vyvráceno | OVĚŘENO testy |
| SYS-4 | hodnotitel 1.1.0: verdikt ovlivní jen blokovaná operace s doslovnou oporou v zadání | OVĚŘENO testy |
| Živý průběh v UI | perzistentní události `run.events` (kroky, modelová volání, učení) | OVĚŘENO v prohlížeči i testy |
| Modrá hlavní odpověď | tokeny `--answer*` pro světlý i tmavý režim, mobil | OVĚŘENO v prohlížeči |
| **Kvalitativní účinnost H-sestav na reálném modelu** | — | **ČEKÁ NA OVĚŘENÍ** (0 reálných experimentů) |

---

## 2. Hranice autority — co se NIKDY neučí

Principy v0.3.1 platí beze změny: *algoritmy řídí, AI interpretuje a tvoří*; *capabilities may grow, authority may not*;
fail-closed; původní prompt beze změny; Goal Contract zamčený a hashovaný; A/B/C/D; povinná verifikace; max. 1 oprava;
mock není důkaz; žádná API fakturace ani placený fallback.

```
┌──────────────── ZÁVAZNÉ (neadaptivní) ────────────────┐   ┌──────── ADAPTIVNÍ (smí se učit) ────────┐
│ H1 cíl · H7 schopnosti (konfigurace) · H8 oprávnění    │   │ H2–H6, H10 a katalog HX-*                │
│ (konfigurace) · H9 rizika (detektory)                  │   │ přidat / odebrat / min. priorita / strop │
│ Goal Contract, akceptační kritéria, SYS-1..4, GOAL-1   │   │ → mění OTÁZKY Gate 0 a jejich PRIORITY   │
│ limity volání, 1 oprava, preflight fakturace           │   │   v Execution Contract                   │
└────────────────────────────────────────────────────────┘   └──────────────────────────────────────────┘
```

Vynucení v kódu:
- `aspectSets.validateSet` — sestava bez H1/H7/H8/H9 je neplatná; strop priority na systémovém hledisku je neplatný.
- `gate0.processGate0` — nejdřív pravidla sestavy (strop → minimální priorita), **potom** systémové podlahy (H7/H8/H9 z
  konfigurace a detektorů, H4 kritická chybějící informace). Sestava je tedy nemůže přebít.
- Sestava nemění Goal Contract, kritéria, oprávnění ani limity — ty vznikají stejně jako v0.3.1.
- Experiment nikdy nevzniká automaticky; reálný experiment vyžaduje `learning.realExperiments.enabled=true` **a**
  výslovné potvrzení v UI (`confirmRealCalls`), má denní limit a nelze ho opakovat nad stejným během (žádné „lovení“
  šťastného výsledku) ani řetězit (experiment nad experimentem).
- Oprava hodnotitele (SYS-4) je **samostatně verzovaná** (`src/core/evaluator.js`, historie verzí v `/api/status`),
  nikoli „naučený úspěch“. Srovnání mezi různými verzemi hodnotitele se nezapočítá.

---

## 3. Učicí smyčka

```
PROFILE ─► výběr H-sestavy (KB) ─► GATE0(sestava) ─► audit/porovnání/rozhodnutí ─► CONTRACTS ─► COMPILE(aspectTrace)
   ─► EXECUTE ─► VERIFY (─► max. 1 REPAIR) ─► REPORT ─► LEARN: diagnóza ─► {hypotézy | srovnání | pozorování} ─► KB
```

Stavový automat v0.4: `RECEIVED → PROFILE → GATE0 → GOAL_AUDIT → GOAL_COMPARE → DECISION → (CLARIFICATION_REQUIRED |
CONTRACTS → [COMPILE → EXECUTE → VERIFY → (REPAIR → VERIFY)] × větev → (BASELINE) → REPORT → LEARN → DONE)`.
Řízený experiment: `RECEIVED → PROFILE → GATE0 → CONTRACTS (zamčený) → … → REPORT → LEARN → DONE`.

### 3.1 Profil zadání (`src/core/profile.js`)
Deterministicky z textu zadání, explicitního cíle, upřesnění a detektorů — bez AI volání. Znaky: `kind` (povaha),
`artifact`, `language`, `constraints`, `context`, `verifiability`, `needs`, `risks`, `explicitGoal`, `size`.
**Klíčové znaky** `kind` + `artifact` se musí shodovat, jinak je úloha „nesouvisející“ a zkušenost se ani nezobrazí.
Shoda je kvalitativní (`strong` = klíčové shodné a nejvýše 2 odlišné znaky; `related`; `none`) a UI vypisuje, které znaky
se shodují a které ne. Žádná procenta.

### 3.2 H-sestavy (`src/core/aspectSets.js`, `src/core/aspects.js`)
`HS-default@v1` = H1–H10 (bezpečná výchozí cesta). Odvozená sestava = rodič + **právě jedna** změna
(`add | remove | floor | cap`); ID se odvozuje z hashe obsahu. Nová hlediska jsou z pevného, verzovaného katalogu:

| ID | Název | Signál z diagnózy, na který odpovídá |
|---|---|---|
| HX-FORMAT | Formální omezení výstupu | nesplněná kontrola rozsahu / formátu |
| HX-EDGE | Okrajové případy a testovatelnost | nesplněné testy funkce / přesný výpočet |
| HX-FIDELITY | Věrnost zdroji a cíli | sémantické nesplnění cíle bez chybějících vstupů |
| HX-LANG | Jazyk a registr odpovědi | jazyk výstupu ≠ jazyk zadání (spolu s obsahovým selháním) |

Katalog záměrně nevyžaduje další AI volání a nemůže do KB zanést text cizí úlohy.

### 3.3 Vliv na Gate 0 a Execution Contract
- `gate0@1.1.0` se ptá přesně na hlediska zvolené sestavy (schéma odpovědi `gate0Schema(ids)` vynucuje jejich počet i ID).
- `execution-contract@1.1.0` uvádí v sekci priorit řádek `Analytická sestava: HS-…@v…` a propisuje zjištění hledisek
  s prioritou P0–P2; P3 se vynechá. `compiledPrompt.aspectTrace` eviduje, co se propsalo a co ne.
- UI (karta „Učení a analytická sestava“) ukazuje vazbu sestava → otázky → zjištění → Execution Contract.

### 3.4 Diagnóza (`src/core/learning.js → diagnoseBranch`)
| Příčina | Kdy | Připisuje se H-sestavě? |
|---|---|---|
| `permission_or_capability` | SYS-4 s doslovnou oporou, blokace, nedostupné schopnosti | ne |
| `missing_input` | sémantické selhání při kritické chybějící informaci (H3/H4) | ne |
| `execution_error` | chyba exekuce, limit volání, SYS-2 (vykázaná blokovaná operace) | ne |
| `evaluator_suspect` | SYS-4 jen z operace „vymyšlené“ modelem (§6.1); PASS s necitovatelným důkazem | ne |
| `evaluation_unavailable` | kritérium nebylo možné ověřit | ne |
| `simulation` | hodnocení provedl mock | ne |
| `interpretation_or_strategy` | obsahové kritérium nesplněno při dostupných vstupech i oprávněních | **ano** — jen tato |

Z neúspěchu se nikdy neusuzuje, že všechna H byla špatná: hypotéza navrhuje jednu cílenou změnu podle signálu.

### 3.5 Hypotézy, srovnání, důvěryhodnost
- **Obohacení**: signál `format | tests | semantic_goal | language` → přidat příslušné HX-* (nebo zvýšit jeho minimální
  prioritu na P1, je-li už v sestavě). Nejvýše 2 kandidáti na běh.
- **Redukce**: jen z **reálného** úspěchu (PASS) — adaptivní hlediska, která skončila s P3 a do promptu se nepropsala.
  Ověřuje se jako „stejná kvalita s menší režií“.
- **Řízené srovnání** (`compareExperiment`): podmínky = stejný Goal Contract (hash), stejná povinná kritéria (hash),
  stejný hodnotitel, stejné šablony, stejný provider a model, původní běh použil základní sestavu a experiment kandidátní.
  Kvalita se porovnává po povinných kritériích (`better | worse | equal | mixed`). Započítá se jen **reálné** srovnání
  se splněnými podmínkami a bez vnější příčiny odchylek.
- **Stav** (`computeStatus`, čistá funkce): `candidate` (0 výher) → `supported` (1 výhra, jen doporučení) → `verified`
  (≥ 2 výhry, 0 proher; tvrdé minimum 2) · `contested` (výhry i prohry, nebo ≥ 2 varovná pozorování) · `refuted`.
- **Pozorování** při aktivním použití ověřené zkušenosti nemá kontrolní skupinu → důvěru může jen **snížit**
  (selhání z příčiny strategie = varování), úspěch ji **nezvyšuje** (korelace není příčina).
- Opakovaný návrh téže hypotézy se jen eviduje (`proposals`), důvěru nezvyšuje.

### 3.6 Knowledge Base (`src/core/knowledge.js`)
- Soubor `data/kb/fr-kb.json` (adresář `data/` je v `.gitignore` → **nikdy do veřejného Gitu**), atomický zápis,
  schéma `fr-kb/1` s migrací; neznámá verze = fail-closed (KB se nepoužije ani nepřepíše, běh pokračuje s výchozí sestavou).
- Ukládá: profil (kategorie), H-sestavy, zkušenost (verdikty, ID kritérií, typy kontrol, třídy příčin, stopa sestavy,
  náklady), doporučení, srovnání, pozorování. **Neukládá** text zadání ani výstupy — jen SHA-256 zadání a ID běhů.
  Přenáší se metoda, nikoli fakta z cizí úlohy.

---

## 4. Živý provozní průběh (UI)

- FR Core zapisuje události `run.events` (`seq, at, kind: stage|call|step, step, status, label, detail, branch,
  call{task, provider, model, simulated, template}, durationMs`). Stavy: běží · hotovo · přeskočeno · zablokováno ·
  zastaveno · selhalo · zjištění. Ukládají se do perzistentního záznamu běhu → přežijí znovuotevření i restart.
- Modelová volání mají vlastní událost „běží“ uloženou **před** voláním, takže je během ~10 s volání vidět, co FR dělá.
- Přenos: stávající polling (700 ms) — bez nové infrastruktury.
- Nezobrazuje se chain-of-thought, syrové výstupy modelu ani odhady v procentech; časy v Europe/Prague.
- Starší běhy (v0.3.x) bez událostí: průběh se odvodí ze `stateHistory` a UI to výslovně uvádí.
- Pořadí: **Hlavní odpověď** (modrá) → **Průběh práce** (fáze + „Právě: …“ + časová osa) → hlavička běhu → verdikty →
  Učení a analytická sestava → Gate 0 → … → telemetrie. Panel „Znalostní báze“ v postranním sloupci + dialog.

Barevné tokeny hlavní odpovědi: `--answer, --answer-border, --answer-bg, --answer-text-bg, --answer-soft` (světlý
i tmavý režim); PASS/PARTIAL/FAIL, simulace a blokace si ponechávají vlastní barvy (simulace a selhání jako horní proužek
a štítek, ne přebarvením rámu).

---

## 5. API (nové / změněné)

| Endpoint | Popis |
|---|---|
| `GET /api/status` | + `version 0.4.0`, `coreAspects`, `aspectCatalog`, `defaultAspectSet`, `evaluator{version, history}`, `learning{…}` |
| `POST /api/runs` | + `learningMode: "auto" \| "default"` (vynutit výchozí sestavu) |
| `GET /api/kb` | přehled KB (doporučení, stavy, důkazy, srovnání, sestavy) — bez textů úloh |
| `POST /api/experiments` | `{baseRunId, recommendationId, provider, confirmRealCalls}` → 202; chyby 400 `BAD_EXPERIMENT`, 403 `NOT_AUTHORIZED` |

Konfigurace (`config/fr.config.json → learning`): `enabled`, `verifyMinWins` (min. 2), `maxExperiences`,
`realExperiments{enabled: false, maxPerDay: 3}`.

---

## 6. Co je ověřeno a co ne

**Deterministické testy (OVĚŘENO):** 91/91 (`start.cmd test`) — původních 72 beze změny + 19 nových
(`test/learning.test.js`, `test/server.test.js`): body B–H zadání (výchozí sestava bez zkušeností; kandidát z diagnózy
a srovnání proti témuž zamčenému kontraktu; nalezení a skutečný vliv ověřené sestavy na Gate 0 i Execution Contract;
nesouvisející úloha ji nepřevezme; jediný úspěch se jen doporučí; oprávnění/hodnotitel se nepřipíše H-sestavě; mock se
nezapočítá; reálný experiment bez povolení a potvrzení odmítnut bez jediného volání; KB lokálně a bez textů; události
živě i po znovuotevření).

**Rozdíl mezi testem toku a důkazem účinnosti:** testy dokazují, že mechanismus funguje (výběr, vazba na prompt, evidence,
pravidla důvěryhodnosti, hranice autority). **Nedokazují**, že kterákoli H-sestava zlepšuje výsledky reálného modelu.
„Ověřené“ doporučení v testech je syntetická fixture. Kvalitativní účinnost se prokáže až řízenými reálnými experimenty
(každý 3–5 volání Claude CLI), které musí povolit uživatel. **Stav: ČEKÁ NA OVĚŘENÍ — 0 reálných experimentů, 0 reálných
volání v této fázi.**

### Známá omezení
1. Profil je heuristický (regex, cs/en); může chybně zařadit neobvyklá zadání → horší vyhledání zkušenosti, nikoli
   porušení autority (při nejistotě platí výchozí sestava).
2. Katalog nových H je pevný (4 položky). Návrh nového hlediska modelem by stál další AI volání — záměrně neimplementováno.
3. Srovnání se dělá jen pro primární větev (B1); u stavu C se alternativní větev v experimentu nespouští.
4. Jedno reálné srovnání je zatížené nedeterminismem modelu; proto min. 2 výhry a zachycení proher/varování.
5. HX-LANG sám nepřebije systémové pravidlo „texty česky“ v šablonách (PASSPORT §6.4) — volba jazyka odpovědi je
   samostatné téma.
6. Běhy z v0.3.1 nelze použít jako základ experimentu (jiná verze hodnotitele a šablon) — srovnání by nebylo férové.
7. Běžící server (spuštěný před v0.4) obsluhuje nový frontend se starým backendem: UI je zpětně kompatibilní (průběh ze
   `stateHistory`, bez karty učení). Plné v0.4 vyžaduje restart serveru — jen se souhlasem a po kontrole `busy`.
