FRANKENSTEIN — v0.3 — Standalone Autonomous Task Cycle
ROLE
Jsi hlavní softwarový architekt a vývojář projektu FRANKENSTEIN (FR).
Použij Claude Opus 5.5 s úrovní uvažování HIGH.
Tvým úkolem je navrhnout, implementovat, otestovat a předat první funkční verzi samostatného univerzálního agenta FRANKENSTEIN.
Nechceme další dlouhou architektonickou studii. Chceme funkční, lokálně spustitelný prototyp, na kterém můžeme ihned experimentovat.
Před implementací proveď krátkou technickou revizi návrhu. Pokud objevíš zásadní rozpor, oprav technické řešení tak, aby byla zachována níže uvedená koncepce. Nežádej souhlas s běžnými implementačními detaily. Eskaluj pouze skutečně zásadní rozhodnutí, bezpečnostní problém nebo riziko fakturace.
Veškerá komunikace, reporty a uživatelské rozhraní budou v češtině.
1. HLAVNÍ CÍL
FRANKENSTEIN musí realizovat kompletní pracovní cyklus:

1. Přijme libovolný uživatelský prompt.
2. Vyhodnotí jej podle deseti univerzálních hledisek.
3. Pro každé hledisko vytvoří strukturovaný report a určí jeho prioritu.
4. Nezávisle audituje skutečný záměr a cíl uživatele.
5. Porovná auditovaný cíl s uživatelským cílem a interpretací H1.
6. Rozhodne podle pravidel A/B/C/D.
7. Vytvoří jeden nebo dva Goal Contracts.
8. Algoritmicky sestaví jeden nebo dva rozšířené exekuční prompty.
9. Předá rozšířené zadání vykonávacímu agentovi.
10. Převezme skutečný výsledek vykonávacího agenta.
11. Ověří výsledek proti Goal Contract a akceptačním kritériím.
12. Předloží uživateli výsledek, report odchylek, výsledek evaluace a kompletní telemetrii spotřeby.

Při opravitelném selhání smí spustit maximálně jeden opravný průchod v rámci nastaveného limitu.
FR musí fungovat samostatně. V této etapě se neintegruje s žádnou externí orchestrační platformou, jejím MCP, její databází ani jiným agentním ekosystémem.
2. ZÁKLADNÍ ARCHITEKTONICKÁ FILOZOFIE
Algoritmy řídí, AI interpretuje a tvoří.
Nesmíme vytvářet systém, který spotřebuje většinu AI kapacity na řízení, kontrolu a opakované hodnocení vlastní činnosti.
Preferuj:

* deterministické stavové automaty;
* strukturované datové kontrakty;
* validovaná schémata;
* algoritmické porovnávání známých vlastností;
* verzované šablony promptů;
* nezávislé testy a měřitelné důkazy;
* využití AI pouze tam, kde je nutná skutečná sémantická interpretace nebo generativní schopnost.

Zachovej princip:
Capabilities may grow; authority may not.
Nevytvářej zbytečnou multiagentní architekturu, auditorské rady ani nové vrstvy governance.
3. TECHNOLOGICKÁ ARCHITEKTURA
Preferovaný základ:

* Node.js backend;
* jednoduchý lokální HTML/CSS/JavaScript frontend;
* samostatné moduly FR Core, Goal Audit, Prompt Compiler, Executor, Verifier a Telemetry;
* lokální perzistentní evidence běhů;
* Claude Code CLI jako AI provider;
* Claude Sonnet 5.5 jako výchozí runtime model;
* mock provider umožňující kompletní testování bez inference.

Zachovej oddělení provideru od algoritmického jádra, aby bylo později možné vyměnit AI model bez přepisování logiky FR.
Nepoužívej API služby vyžadující samostatnou fakturaci.
4. GATE 0 — DESET HLEDISEK
Implementuj deset univerzálních hledisek:
H1 — Záměr a výsledek
H2 — Povaha úlohy
H3 — Kontext a vstupy
H4 — Určitost zadání
H5 — Ověřitelnost
H6 — Metoda řešení
H7 — Dostupné schopnosti
H8 — Oprávnění a autonomie
H9 — Rizika a důsledky
H10 — Efektivita a budoucí využitelnost
Každé hledisko musí vrátit:

* strukturované zjištění;
* prioritu P0–P3;
* zdůvodnění priority;
* důkazy z původního promptu;
* předpoklady a neznámé skutečnosti;
* případné chybějící informace;
* doporučení pro následné zpracování.

Všech deset hledisek zpracuj přednostně v jednom AI volání.
Rozšiř strukturované reporty o rozsah, výslovné ne-cíle, interní rozpory, závislosti a případnou citlivost dat.
Nevydávej předpoklady AI za skutečně ověřená fakta.
Dostupné schopnosti FR a jeho oprávnění jsou určovány systémovou konfigurací, nikoliv tvrzením AI.
5. GOAL AUDIT
Po dokončení desatera proveď nezávislý audit cíle.
Audit dostane původní zadání a případnou explicitní definici cíle, nikoliv report H1.
Použij novou, izolovanou analytickou relaci.
Výstupem musí být:

* auditovaný cíl;
* strukturovaná reprezentace cíle;
* důkazy a předpoklady;
* omezení a rozsah;
* navržená akceptační kritéria;
* hlavní nejistoty;
* případné alternativní interpretace.

Potom porovnej:

1. explicitní uživatelský cíl;
2. definici cíle vytvořenou v H1;
3. nezávisle auditovaný cíl.

Původní report H1 musí zůstat zachován. Korekce se zaznamená jako samostatný výsledek.
Sémantické posouzení neoznačuj za deterministické, pokud ve skutečnosti vychází z úsudku modelu.
6. ROZHODOVACÍ BRÁNA A/B/C/D
Použij kvalitativní hodnocení rozdílů cílů. Nepoužívej procentuální podobnost ani prahovou hodnotu 85 %.
A — Cíl nebyl přímo definován.
Je-li spolehlivě odvoditelný, FR vytvoří jeden odvozený Goal Contract a pokračuje.
Nelze-li jej spolehlivě odvodit, přejde do STOP / CLARIFICATION.
B — Cíle jsou významově shodné.
FR vytvoří jeden sjednocený Goal Contract a pokračuje.
C — Cíle se nekriticky liší.
FR vytvoří dva oddělené Goal Contracts.
Následně vytvoří dva samostatné exekuční prompty, získá dvě řešení a každé zvlášť vyhodnotí.
Explicitní uživatelský cíl má vyšší autoritu než auditní alternativa. Nesmí dojít k jejich nepozorovanému sloučení.
D — Kritický nebo nevyjasněný rozpor.
FR zastaví exekuci a vytvoří konkrétní upřesňující otázku zaměřenou na zjištěný rozpor.
Algoritmické jádro vykonává procesní rozhodnutí podle validovaných strukturovaných údajů a rozhodovací tabulky.
Tam, kde je nezbytné významové posouzení AI, musí být jeho původ transparentní.
Rutinní Goal Lock ve stavech A/B/C nevyžaduje opakované potvrzování člověkem. Samostatná autorizace se týká až operací překračujících oprávnění nebo představujících významné nevratné důsledky.
7. GOAL CONTRACT
Definuj verzovaný, neměnný cílový kontrakt, který obsahuje minimálně:

* identifikátor a verzi;
* slovní definici cíle;
* strukturované významové složky;
* původ cíle a vazbu na originální prompt;
* očekávaný výstup;
* rozsah a ne-cíle;
* omezení;
* kritéria úspěchu;
* metody jejich ověření;
* podstatné předpoklady;
* status A/B/C;
* případnou vazbu na alternativní větev.

Goal Contract bude kontrolním majákem pro exekuci a závěrečnou evaluaci.
Případná změna cíle musí být explicitní a verzovaná.
8. PROMPT COMPILER
Implementuj samostatný algoritmický modul pro konstrukci rozšířeného promptu.
Tento modul NESMÍ rutinně vyvolávat AI.
Z validovaných struktur musí deterministicky sestavit Execution Contract obsahující:

* původní zadání v nezměněné podobě;
* aktuální Goal Contract;
* relevantní zjištění z deseti hledisek;
* dynamické priority;
* povinná omezení;
* identifikované chybějící informace;
* předpoklady oddělené od faktů;
* požadovaný výstup;
* akceptační kritéria;
* požadovaný způsob vykazování výsledku.

Musí být možné zobrazit a exportovat přesný prompt, který byl předán vykonávacímu agentovi.
Šablony musí být verzované.
Prompt Compiler nesmí potichu měnit uživatelský cíl ani doplňovat neověřené skutečnosti.
9. TASK EXECUTOR
Implementuj univerzální exekuční adaptér.
Preferovaný runtime model: Claude Sonnet 5.5 prostřednictvím Claude Code CLI.
Executor přijímá Execution Contract a vrací výsledek ve strukturované podobě.
Pokud existuje odpovídající bezpečný deterministický nástroj, preferuj jej před AI.
Pro první MVP postačuje plnohodnotné zpracování textových, analytických, strukturovaných a vhodných programátorských zadání v rozsahu skutečně dostupných nástrojů.
Nedostupné nebo nepovolené operace musí být označeny jako nepodporované či blokované. Nevykazuj jejich splnění.
Externí zásahy ani nevratné operace neprováděj bez odpovídající autorizace.
Ve stavu C spusť oddělené exekuce pro oba cíle.
10. RESULT VERIFIER
Po dokončení exekuce porovnej výsledek s příslušným Goal Contract.
Verifikace musí být založena na jednotlivých akceptačních kritériích.
Každé kritérium bude mít:

* požadovanou podmínku;
* metodu ověření;
* výsledek ověření;
* důkaz nebo popis jeho absence;
* případnou odchylku.

Preferuj deterministické validace, testy a kontroly struktury.
AI hodnotitele použij pouze pro skutečně sémantické požadavky, které nelze algoritmicky ověřit.
Sémantický hodnotitel pracuje v oddělené relaci. Nedostane interní uvažování vykonávacího modelu.
Celkový verdikt musí být jeden z:

* PASS
* PARTIAL
* FAIL
* UNVERIFIED

Žádný výsledek nesmí být označen PASS, pokud nejsou prokázána povinná kritéria úspěchu.
Při opravitelném selhání smí FR provést maximálně jeden řízený opravný průchod na základě konkrétních nesplněných kritérií.
Opravný průchod se nesmí spustit, pokud by překročil oprávnění nebo stanovené limity.
Původní i opravený výsledek musí zůstat evidovány.
11. FRONTEND
Vytvoř jednoduchou, přehlednou a vizuálně kvalitní lokální webovou aplikaci.
Minimální funkce:

1. Pole pro původní prompt.
2. Volitelné pole pro explicitní definici cíle.
3. Tlačítko spuštění.
4. Přehled průchodu jednotlivými fázemi.
5. Deset rozbalovacích reportů a jejich priority.
6. Auditovaný cíl a porovnání s H1 a cílem uživatele.
7. Rozhodnutí A/B/C/D.
8. Zobrazení jednoho nebo dvou Goal Contracts.
9. Zobrazení skutečně sestaveného rozšířeného promptu.
10. Výsledek exekučního agenta.
11. Hodnocení splnění jednotlivých kritérií.
12. Celkový verdikt a případné odchylky.
13. Tokenová, časová a nákladová telemetrie.
14. Historie běhů a export strukturovaných výsledků.

V případě D nabídni možnost doplnit odpověď na upřesňující otázku a pokračovat s doloženou historií.
Zabraň tomu, aby se nové zadání nebo oprava zpracovávaly jako nekontrolovaná souběžná relace.
12. NÁKLADY A VÝKON
Pro každé AI volání a celý průchod eviduj:

* model a verzi;
* počet vstupních a výstupních tokenů;
* dostupné cache metriky;
* dobu trvání;
* počet volání a opakování;
* případný odhad nákladového ekvivalentu v USD;
* informace o autentizačním a fakturačním režimu;
* dobu algoritmického zpracování;
* konečný stav.

Rozlišuj naměřenou spotřebu, odhad USD a skutečně ověřenou fakturaci.
Neoznačuj teoretický dolarový náklad za skutečně zaplacené peníze.
Připrav volitelný experimentální režim BASELINE vs. FR pro srovnání přímého modelového řešení s kompletním FR cyklem.
Baseline se nesmí automaticky spouštět při každém uživatelském zadání.
13. ABSOLUTNÍ ZÁKAZ API FAKTURACE
Používej pouze existující oprávněné předplatné Claude Code.
Žádné přímé Anthropic API, API key pay-as-you-go, placené kredity ani jiný automatický zpoplatněný fallback.
Před první inferencí vznikající aplikace proveď bezpečnostní kontrolu:

* zjisti verzi CLI a podporované parametry;
* ověř přihlašovací metodu pomocí dostupných oficiálních prostředků, včetně `claude auth status`;
* vyluč API credentials a nechtěná alternativní připojení;
* prověř nastavení placené extra usage;
* ověř použitelnost izolovaného `--safe-mode`;
* nedovol neautorizované načítání MCP, hooků, projektové paměti nebo jiných konfigurací;
* omez dostupné nástroje, timeouty, paralelismus a opravné pokusy.

Nepoužívej `--bare`, pokud vyžaduje API autentizaci.
Samotná absence API klíče není dostatečným důkazem nulové dodatečné fakturace.
Pokud bezpečný předplatitelský provoz nedokážeš ověřit, zastav reálné inference a dokonči testování prostřednictvím mock provideru.
Žádnou placenou cestu nesmíš aktivovat kvůli překonání blokace.
14. TESTY
Připrav deterministické testy bez AI pro:

* všech deset reportových struktur;
* priority;
* extrakci a evidenci explicitního cíle;
* rozhodnutí A/B/C/D;
* neodvoditelný cíl;
* kritický a nekritický rozdíl;
* dvě větve C;
* Prompt Compiler;
* zachování originálního zadání;
* Goal Contract;
* algoritmické vyhodnocení výsledku;
* PASS / PARTIAL / FAIL / UNVERIFIED;
* maximálně jeden opravný průchod;
* bezpečnost a odmítnutí neoprávněné akce;
* prompt injection;
* evidenci tokenů a časů;
* blokaci API fakturace.

Zajisti minimálně několik odlišných end-to-end testovacích scénářů, například strukturovanou transformaci dat, matematický úkol, analýzu textu a vytvoření jednoduchého programu.
U jednotlivých scénářů jasně rozliš, co bylo reálně vykonáno a co bylo pouze simulováno.
Reálné Sonnet testy spouštěj až po ověření bezpečného fakturačního režimu.
15. PRACOVNÍ POSTUP
Nejdříve ověř, zda pracuješ ve správném samostatném repozitáři FRANKENSTEIN, jeho Git stav, aktuální `main` a případný remote.
Nezasahuj do jiných projektů ani repozitářů.
Pokud samostatný repozitář FR dosud neexistuje, vytvoř lokální samostatný projekt; remote si nevymýšlej.
Před exekucí stručně oznam, jaké moduly vytvoříš, které kroky poběží automaticky, kde je případně nutný zásah člověka a podle čeho poznáme úspěch.
Potom implementuj.
Pro běžné technické volby nevyžaduj opakované potvrzování. Nepřidávej široké governance kontroly, cross-repo audity ani nákladné validační procedury nesouvisející s úkolem.
Canonical kopii tohoto zadání ulož v repozitáři do `/prompts/`.
Pokud projekt používá Git s definovaným `main` a schváleným publikačním postupem, po dokončení proveď tematický commit a push na `main` podle platných pravidel. V opačném případě zachovej lokální změny a přesně uveď, proč publikace neproběhla.
16. AKCEPTAČNÍ KRITÉRIA
Implementaci považuj za dokončenou, pokud:

* lze otevřít lokální frontend;
* lze zadat libovolný prompt;
* vznikne deset reportů a audit cíle;
* stav A/B/C/D funguje podle pravidel;
* ve stavu C vzniknou dvě oddělené exekuční větve;
* je vidět rozšířený prompt;
* Executor vrací skutečný výsledek;
* Verifier tento výsledek hodnotí proti Goal Contract;
* jsou dostupné jednotlivé důkazy, odchylky a verdikt;
* jsou vidět náklady a časy celého cyklu;
* výsledky lze uložit a znovu otevřít bez další inference;
* všechny deterministické testy procházejí;
* neexistuje aktivní ani automatický přechod na API fakturaci.

Žádnou neověřenou část neoznačuj jako hotovou.
17. FINÁLNÍ REPORT
Po dokončení předej v češtině:

1. Stručné shrnutí implementované architektury.
2. Přesný návod ke spuštění.
3. Popis fungování jednotlivých modulů.
4. Výsledky provedených testů.
5. Jeden ukázkový kompletní průchod, pokud bylo možné bezpečně spustit skutečnou inferenci.
6. Přesnou spotřebu modelových volání a času.
7. Známá omezení.
8. Git stav, commit a informaci o publikaci.
9. Co doporučuješ zlepšit ve verzi 0.4.

Hlavní priorita: funkční a ověřitelný první autonomní cyklus FRANKENSTEINa, nikoliv rozsáhlý framework.
Začni krátkou technickou revizí a následně přejdi k implementaci. Práci nepovažuj za dokončenou pouze na základě vytvořených souborů nebo úspěšné kompilace. Musí existovat funkční průchod od přijetí promptu až po ověření výsledku.
