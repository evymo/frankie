# FRANKENSTEIN v0.4 — podklad a zadání pro 90sekundovou prezentaci (CX)

**Účel:** CX z tohoto dokumentu vyrobí moderní, přehlednou prezentaci ve formátu **PowerPoint (.pptx)** na **90 sekund**.
Část A je věcné povídání o tom, jak FRANKENSTEIN funguje (zdroj obsahu). Část B je zadání prezentace.
**Tým:** Aisha — Zdeněk Bělka, Ladislav Habásko, Martin Landa.
**Kanonické zdroje:** [`docs/ARCHITEKTURA-v0.4.md`](../docs/ARCHITEKTURA-v0.4.md), [`docs/PASSPORT-v0.3.1.md`](../docs/PASSPORT-v0.3.1.md),
[`README.md`](../README.md), [`knowledge/README.md`](../knowledge/README.md). Při rozporu platí kód a tyto dokumenty na `main`.

---

## ČÁST A — Povídání: jak FRANKENSTEIN funguje

### 1. O co jde

FRANKENSTEIN (zkráceně FR) je lokální agent, který s uživatelským zadáním nezachází jako s hotovým příkazem.
Nejdřív ho **rozebere, ověří a přepracuje na přesný, kontrolovatelný pokyn**, teprve potom ho předá vykonávacímu
modelu a výsledek **nezávisle ověří**. Z každého běhu si navíc **odnese zkušenost** a postupně zdokonaluje vlastní
postup analýzy.

Cílový stav: sofistikovaný, ověřený prompt dostane **lokální agent** (menší model běžící u nás). Dokud ho nemáme
nasazený, zastupuje ho **Claude Sonnet** volaný přes Claude Code CLI s předplatným (žádné placené API).

### 2. Proč prompt přepracováváme

Běžný prompt je nepřesný: chybí v něm cíl, rozsah, formát nebo kritéria, občas obsahuje rozpor nebo požadavek, na
který agent nemá oprávnění. Když ho dostane model napřímo, hrozí:
- **posun cíle** — model vyřeší něco jiného, než uživatel chtěl,
- **vymyšlená fakta** — předpoklady se tváří jako jistota,
- **neověřený výsledek** — nikdo nezkontroluje, zda je úloha opravdu splněná,
- **překročení oprávnění** — „pošli to e-mailem“, „smaž soubory“, prompt injection.

U menšího lokálního modelu to platí dvojnásob: má méně schopnosti si nejasnosti domyslet. Proto mu FR předává
**hotový, jednoznačný kontrakt** místo surového textu.

Základní princip: **„Algoritmy řídí, AI interpretuje a tvoří.“** Pořadí kroků, limity, rozhodnutí, sestavení promptu
i verdikt dělá kód. Model se volá jen tam, kde je potřeba porozumění textu nebo tvorba.

### 3. Proces zpracování krok za krokem

1. **Příjem zadání.** Původní prompt se uloží **beze změny** (s otiskem SHA-256) a do všech dalších promptů jde
   doslovně, bezpečně ohraničený, aby ho nešlo „přepsat“ zevnitř.
2. **Profil zadání a výběr analytické sestavy** (bez AI). FR určí charakteristiku úlohy (viz učení, kap. 5) a vybere
   sadu analytických hledisek.
3. **Gate 0 — analýza podle hledisek** (1 AI volání). Výchozích 10 hledisek:
   H1 záměr a výsledek · H2 povaha úlohy · H3 kontext a vstupy · H4 určitost zadání · H5 ověřitelnost ·
   H6 metoda řešení · H7 dostupné schopnosti · H8 oprávnění · H9 rizika a důsledky · H10 efektivita.
   U každého hlediska vznikne zjištění, priorita P0–P3, doslovné důkazy ze zadání, předpoklady a chybějící informace.
   **Schopnosti (H7) a oprávnění (H8) neurčuje model, ale konfigurace** — tvrzení modelu se jen eviduje.
   Deterministické detektory hlídají prompt injection, citlivá data a operace mimo oprávnění.
4. **Nezávislý audit cíle** (1 AI volání v izolované relaci). Druhý „auditor“ určí cíl, aniž by viděl výsledek
   Gate 0, a navrhne měřitelná akceptační kritéria.
5. **Porovnání cílů** (0–1 AI volání). Explicitní cíl uživatele, cíl z H1 a auditovaný cíl se porovnají kvalitativně
   (shodné / nekritický rozdíl / kritický rozpor / nejasné). Kde to jde, rozhodne algoritmus bez AI.
6. **Rozhodovací brána A/B/C/D** (čistá tabulka pravidel, bez AI):
   - **A** — bez explicitního cíle, audit ho spolehlivě odvodil → pokračuje se; cíl neodvoditelný → STOP a otázka,
   - **B** — explicitní cíl shodný s analýzou → jeden společný kontrakt,
   - **C** — nekritický rozdíl → dvě oddělené varianty (primární = cíl uživatele),
   - **D** — kritický rozpor → STOP a konkrétní upřesňující otázka. FR raději se zeptá, než aby hádal.
7. **Goal Contract.** Cíl, rozsah, ne-cíle, omezení, kritéria úspěchu a blokované operace se **zamknou** do
   neměnného kontraktu s hashem. Změna je možná jen jako nová, výslovná verze.
8. **Execution Contract — sofistikovaný prompt**, sestavený **algoritmem, ne modelem**, deterministicky a verzovaně:
   pravidla, původní zadání, Goal Contract, priority a zjištění z analýzy, povinná omezení, blokované operace,
   chybějící informace, oddělená fakta a předpoklady, požadovaný výstup a akceptační kritéria.
9. **Exekuce.** Pokud úlohu úplně vyřeší deterministický nástroj (přesný výpočet, převod CSV→JSON), použije se bez AI.
   Jinak kontrakt dostane vykonávací agent — dnes Sonnet, cílově lokální model.
10. **Verifikace — poslední hodnoticí brána.** Každé kritérium se ověří zvlášť: deterministicky (číslo, JSON schéma,
    počet slov, testy kódu v izolovaném sandboxu…) nebo nezávislým sémantickým hodnotitelem, jehož PASS platí jen
    s doslovnou citací z výstupu. Systémová kritéria hlídají neprázdný výstup, že agent nevykazuje zakázané operace,
    formát a rozsah oprávnění. Verdikt: **PASS** jen když jsou prokázána všechna povinná kritéria; jinak
    PARTIAL / FAIL / UNVERIFIED. **Co nejde ověřit, není PASS.**
11. **Nejvýše jedna řízená oprava** — jen podle konkrétních nesplněných kritérií, nikdy kvůli bezpečnosti.
12. **Report, telemetrie a učení.** Volání, tokeny, časy, odhad nákladů; pak diagnóza a zápis zkušenosti (kap. 5).

Typický běh: ~5 modelových volání, strop 14. Ochrana fakturace: reálná inference jen přes předplatné ověřené
preflightem, žádné API klíče, žádný placený záložní provider. Simulace (mock) nikdy nevytvoří PASS.

### 4. Hodnoticí brány — co zajišťují

| Brána | Co hlídá |
|---|---|
| Gate 0 (hlediska) | rizika, chybějící informace, oprávnění a schopnosti podle konfigurace, prompt injection |
| Audit cíle | nezávislý druhý pohled na cíl, návrh měřitelných kritérií |
| Rozhodnutí A/B/C/D | rozpor nebo nejasnost → stop a otázka místo hádání |
| Verifikace | každé kritérium doloženo; neověřitelné ≠ PASS; max. 1 oprava |

Tři záruky v jedné větě: **cíl se po cestě neztratí, agent nedělá víc, než smí, a výsledek je doložený.**
Další pravidlo: *„Capabilities may grow; authority may not.“* — schopnosti mohou růst, pravomoci ne.

### 5. Adaptivní učení — FR zdokonaluje vlastní postup (v0.4)

Deset hledisek je dobrá univerzální výchozí sada, ale ne optimum pro každý typ úlohy. FR se proto učí, **která
kombinace analytických hledisek („H-sestava“) se pro jaký typ úlohy prokazatelně osvědčuje.**

**Smyčka:**
1. **Profil úlohy** (bez AI): povaha požadavku, očekávaný výstup, jazyk, omezení, kontext, ověřitelnost, potřebné
   schopnosti, rizika. Podobnost je slovní (shodné / odlišné znaky), ne procentní.
2. **Výběr H-sestavy** z Knowledge Base. Aktivně se použije **jen ověřená zkušenost** se silnou shodou typu úlohy;
   ostatní se jen zobrazí jako doporučení. Bez zkušenosti platí bezpečná výchozí sestava.
3. **Běh a ověření** — stejné brány jako vždy. Zvolená sestava skutečně mění otázky analýzy a to, co se propíše do
   exekučního promptu; FR tu vazbu eviduje.
4. **Diagnóza.** U každé odchylky FR rozliší příčinu: oprávnění/schopnost, chybějící vstupy, chyba exekuce,
   podezření na vadný hodnotitel, neproběhlé ověření, simulace — nebo **interpretace/strategie analýzy**.
   Jen ta poslední se připíše analytické sestavě; z neúspěchu se nikdy neusuzuje, že všechna hlediska byla špatná.
5. **Hypotéza.** Jedna cílená změna sestavy: přidat nové hledisko z verzovaného katalogu (např. „Formální omezení
   výstupu“, „Okrajové případy a testovatelnost“, „Věrnost zdroji a cíli“, „Jazyk odpovědi“), zvýšit prioritu,
   nebo naopak odebrat hlediska, která se do promptu nepropsala (stejná kvalita s menší režií).
6. **Řízený experiment** — spouští ho uživatel. Týž prompt, **týž zamčený Goal Contract**, stejná povinná kritéria,
   stejný hodnotitel i model; mění se jen H-sestava. Výsledky se porovnají kritérium po kritériu.

**Důvěryhodnost roste jen důkazy:** kandidát → předběžně podpořeno (1 reálné srovnání) → **ověřeno (≥ 2 reálná
srovnání bez vyvrácení)**; prohry vedou na „sporné“ nebo „vyvráceno“. Simulace se eviduje, ale nezapočítává.
Úspěch bez kontrolní skupiny důvěru nezvyšuje (korelace není důkaz), selhání ji snížit může.

**Hranice: učí se metoda, nikdy autorita.** Cíl (H1), schopnosti (H7), oprávnění (H8), rizika (H9) a systémová
kritéria jsou v každé sestavě a učení je nesmí odebrat ani oslabit. Opravy hodnotitele jsou samostatně verzované,
nikdy se nevydávají za „naučený úspěch“.

### 6. Vlastní Knowledge Base týmu

- Je **sdílená v Git repozitáři** (`knowledge/`): každý záznam je samostatný soubor, nic se nepřepisuje, stav důvěry
  se dopočítá při načtení. Celý tým si zkušenosti vyměňuje přes `git pull` / `push` bez konfliktů a FR si před
  každým zadáním načte zkušenosti všech.
- Ukládá **metodu, ne obsah**: typ úlohy, použitou sestavu, příčiny odchylek, kandidáty a výsledky srovnání.
  **Žádné texty zadání, odpovědi ani jejich otisky** (repozitář je veřejný).
- Každý běh tak přidá zkušenost — a ověřené postupy FR použije sám a vždy uvede, na základě čeho.

### 7. Jak to vypadá pro uživatele

Webové UI (lokálně) s přepínačem **Provozní / Detailní**:
- **Provozní** — jako běžný agent: zadání, stručné kroky („Analyzuji zadání“, „Kontroluji výsledek…“) a modře
  zvýrazněná odpověď se srozumitelným stavem (Ověřeno / Splněno částečně / …).
- **Detailní** — celý vnitřní průběh: hlediska, audit, rozhodnutí, kontrakty, exekuční prompt, verifikace, učení,
  telemetrie a živá časová osa.

### 8. Stav a další krok (ověřená fakta — jiná čísla nepoužívat)

- verze **v0.4** — funkční prototyp s adaptivním učením a sdílenou Knowledge Base,
- **93** deterministických testů (bez AI), všechny procházejí,
- **10** výchozích analytických hledisek, **max. 1** oprava na větev, **≥ 2** reálná srovnání pro ověření zkušenosti,
- celý cyklus ověřen v simulaci i reálnými běhy na Claude Sonnet (v0.3.1),
- **otevřené:** přínos učení na reálném modelu teprve ověřujeme řízenými experimenty — **neprezentovat jako prokázaný.**
- další krok: nahradit Sonnet lokálním modelem · reálné experimenty · sdílení plných běhů v privátním úložišti.

---

## ČÁST B — Zadání prezentace pro CX

**Výstup:** jeden soubor `.pptx` (16:9), uložit do `docs/prezentace/FRANKENSTEIN_Aisha_90s.pptx`, v češtině.
**Délka:** 90 sekund mluveného slova → **7 slajdů**, mluvený text (~200 slov) do poznámek řečníka s časováním.
**Publikum:** odborné, ale ne nutně vývojáři — musí pochopit proč, jak a co je na tom nové.

### Povinná sdělení
1. Proces zpracování a **proč** prompt přepracováváme a validujeme přes hodnoticí brány.
2. Sofistikovaný prompt předáváme **lokálnímu agentovi** (dnes ho zastupuje Sonnet).
3. **Adaptivní učení** — zdokonalování workflow.
4. Současná tvorba **vlastní Knowledge Base**.
5. Tým Aisha a jeho členové.

### Struktura (doporučená)
| # | Slajd | Hlavní sdělení | Vizuál | Čas |
|---|---|---|---|---|
| 1 | Titul | FRANKENSTEIN — z nepřesného promptu ověřený kontrakt pro lokálního agenta, s postupem, který se učí. Tým Aisha + 3 jména | velký název, abstraktní síť uzlů | 0:00–0:08 |
| 2 | Proč | Nepřesný prompt = nespolehlivý agent (posun cíle, vymyšlená fakta, neověřený výsledek) | „před/po“: chaotický prompt → čistý kontrakt | 0:08–0:20 |
| 3 | Proces | 8 kroků: zadání → 10 hledisek → audit cíle → brána A/B/C/D → Goal Contract → prompt (sestaví algoritmus) → lokální agent (dnes Sonnet) → verifikace | horizontální pipeline, brány odlišené barvou | 0:20–0:38 |
| 4 | Brány | cíl se neztratí · agent nedělá víc, než smí · výsledek je doložený; „Algoritmy řídí, AI interpretuje a tvoří.“ | 3 ikony + citát | 0:38–0:50 |
| 5 | Učení | smyčka profil → výběr hledisek → běh → diagnóza → řízený experiment; důvěra kandidát → podpořeno → ověřeno (≥ 2); učí se metoda, ne autorita | kruhový diagram + žebříček důvěry | 0:50–1:08 |
| 6 | Knowledge Base | vlastní, sdílená v Gitu, metoda ne obsah, roste s každým během | strom souborů `knowledge/…` | 1:08–1:20 |
| 7 | Stav a další krok | v0.4 · 93 testů · 10 hledisek · ≥ 2 srovnání; lokální model, reálné experimenty; poděkování, tým | velká čísla | 1:20–1:30 |

### Mluvený text (do poznámek, cca 90 s)
1. „Jsme tým Aisha a představujeme FRANKENSTEIN — agenta, který z nepřesného promptu udělá ověřený kontrakt pro
   lokálního agenta a z každého běhu se učí.“
2. „Běžný prompt je nepřesný. Když ho model dostane napřímo, hrozí posun cíle, vymyšlená fakta a výsledek, který
   nikdo neověří. U menšího lokálního modelu dvojnásob.“
3. „Proto zadání nejdřív rozebereme podle deseti hledisek, cíl nezávisle zkontroluje druhý auditor a rozhodovací
   brána řekne, jestli pokračovat, nebo se zeptat. Cíl zamkneme do kontraktu a algoritmus z něj sestaví přesný
   prompt. Ten dostane lokální agent — zatím ho zastupuje Claude Sonnet — a výsledek ověříme proti každému kritériu.“
4. „Brány zajistí, že se cíl neztratí, agent nedělá víc, než smí, a výsledek je doložený. Algoritmy řídí, AI
   interpretuje a tvoří.“
5. „A FR se učí. Podle typu úlohy si vybere osvědčenou sadu hledisek, po běhu zjistí, proč něco nevyšlo, a změnu
   ověří řízeným experimentem se stejným zamčeným cílem. Zkušenost platí až po dvou reálných srovnáních. Učí se
   metoda, nikdy pravomoci.“
6. „Tak vzniká naše vlastní Knowledge Base — sdílená v Gitu, s metodou, ne s obsahem zadání. Z každého běhu se
   učí celý tým.“
7. „Dnes máme funkční prototyp verze 0.4 s 93 testy. Dál nahradíme Sonnet lokálním modelem a reálnými experimenty
   ověříme přínos učení. Děkujeme — tým Aisha.“

### Design
- **Moderně a přehledně:** jedna myšlenka na slajd, málo textu, diagramy místo odrážek, velká typografie.
- Doporučený směr: tmavý „keynote“ styl (tmavě modré pozadí, světlý text), **modrá** pro proces a učení,
  **oranžová/jantarová výhradně pro hodnoticí brány**; jeden výrazný akcentní slajd (např. „Proč“).
- Písma: moderní sans (např. Space Grotesk / Inter / IBM Plex Sans); minimálně 24 pt ekvivalent u veškerého textu.
- Ikony jednotného stylu; žádné fotky lidí ani loga cizích firem.
- Diagramy musí odpovídat realitě procesu (8 kroků, 4 brány, smyčka 5 kroků) — nic nepřidávat.

### Pravidla
- **Nevymýšlet čísla ani citace.** Použít jen fakta z části A, kap. 8.
- **Nepřehánět:** přínos učení na reálném modelu je zatím neověřený — neříkat „FR je lepší / chytřejší o X %“.
- Žádná tajemství, interní cesty ani data běhů. Jména členů týmu jen na titulním a závěrečném slajdu.
- Před prací ověřit aktuální `main`; po dokončení commit (`docs(prezentace): …`) a push na `main`, krátký report česky.
