FRANKENSTEIN v0.4 — Adaptive H-Set Learning, průběh práce v UI a sdílené prompty

# ROLE A CÍL

Jsi Claude Code (CC), hlavní implementační architekt projektu FRANKENSTEIN (FR). Navazuješ na funkční v0.3.1. Komunikuj a reportuj česky.

Realizuj první skutečně funkční verzi ADAPTIVNÍHO UČENÍ FR: systém, který dokáže z neúspěšných i úspěšných zpracování zjistit, která ANALYTICKÁ HLEDISKA (H1–H10 a případná nová H) zlepšují dosažení zamčeného cíle, ověřovat alternativní kombinace a uchovávat podložené zkušenosti pro budoucí podobné úlohy. Zároveň zpřehledni průběžné dění v UI a modře vizuálně odliš hlavní odpověď.

V tomto zadání ti dávám skutečnou architektonickou svobodu: můžeš navrhnout lepší strukturu modulů, model charakteristiky úloh, indexování zkušeností, výběr sestav a strategii experimentů. Nemusíš mechanicky realizovat níže naznačené moduly ani počty kroků. Optimalizuj na jednoduchost, skutečný přínos, determinismus, měřitelnou kvalitu, rychlost a počet AI volání. Nepřidávej zbytečné agenty, governance vrstvy ani komplikované frameworky.

Úspěchem je použitelná, bezpečná a vysvětlitelná učicí smyčka — nikoli jen nový diagram, databázová tabulka nebo simulované tvrzení, že se FR učí.

# 0. REPO, ZDROJE A PROVOZNÍ PRAVIDLA

Repo: https://github.com/evymo/frankie, větev main.
Lokální projekt dle passportu: G:\Můj disk\FRANKENSTEIN\frankenstein.
Git: C:\Program Files\Git\cmd\git.exe; Git data jsou mimo Google Drive přes separate git dir.
Node nemusí být na PATH; použij existující FR_NODE a postup v passportu §8.

Nejdřív načti:
- docs/PASSPORT-v0.3.1.md (zejména §2, §3, §6, §7, §8, §9);
- prompts/FRANKENSTEIN_v0.3_zadani.md;
- README.md;
- relevantní kód src/core, src/tools, src/server.js, public.

Ověř poslední tři commity, aktuální main, pracovní strom a start.cmd test. Výchozích 72 testů má zůstat funkčních. Pokud existují cizí rozpracované změny, bezpečně je odděl; nepřepisuj je. Nezasahuj do jiných repozitářů.

Bez explicitního Martinova souhlasu:
- nespouštěj reálnou inferenci Claude CLI, ad-hoc claude -p ani placené experimenty;
- nerestartuj běžící server (nejdřív by bylo nutné ověřit /api/status → busy);
- nezaváděj žádnou API fakturaci ani automatickou placenou zálohu.

Mock a deterministické testy jsou povolené, ale mock sám o sobě neprokazuje kvalitativní zlepšení skutečného modelu.

# 1. NOVÝ ZÁKLADNÍ PRINCIP — FR SE UČÍ Z ÚČINNOSTI HLEDISEK

Dnešní H1–H10 jsou výchozí univerzální analytickou sestavou, nikoli neměnným optimem pro všechny druhy úloh. Chceme, aby FR uměl pro určitou charakteristiku promptu upřednostnit sestavu hledisek, která se při srovnatelných úlohách prokazatelně osvědčila.

Základní mechanismus:

1. FR zachytí charakteristiku nového zadání: povahu požadavku, cíl a očekávaný artefakt, omezení, kontext, ověřitelnost, jazyk, schopnosti, rizika a další smysluplné rozlišující znaky. Nemá jít jen o lexikální podobnost textu. Profil vzniká pokud možno z již dostupných údajů bez dalšího AI volání.
2. FR vyhledá zkušenosti podobného charakteru. Získá případná doporučení pro analytickou sestavu, priority nebo interpretaci hledisek a jejich důvěryhodnost. Bez použitelných zkušeností zůstane bezpečná výchozí sestava.
3. Vybraná sestava skutečně ovlivní analytické reporty a následný deterministicky kompilovaný Execution Contract. Nestačí ji jen zobrazit v UI. Dolož vazbu mezi použitou H-sestavou, zjištěními z reportů a tím, co se promítlo do exekučního promptu.
4. Při nesouladu výsledku se zamčeným Goal Contract proveď diagnostiku. Rozliš zejména chybnou interpretaci/analytickou strategii, nedostatečné vstupy, nedostupné oprávnění či nástroj, chybu exekuce a chybu samotného hodnotitele (např. známé falešné SYS-4). Z neúspěchu automaticky nevyvozuj, že všechna použitá H byla špatná.
5. Identifikuj hypotézy o přínosu nebo škodlivosti konkrétních analytických reportů. Navrhni odstranění, snížení priority, přeformulování či nahrazení méně užitečných hledisek novými, účelnějšími H. Nová hlediska mají strukturovanou, verzovanou definici a důvod svého vzniku.
6. Kde to dovoluje autorizace, rozpočet a limity, umožni kontrolovaný experiment alternativní H-sestavy. Porovnávej proti TÉMUŽ zamčenému cíli a nezměněným povinným akceptačním podmínkám. Výstup a způsob hodnocení musí být dohledatelný. Neměň pravidla měření jen proto, aby nová sestava získala PASS.
7. Ulož zkušenost do Knowledge Base: charakteristika úlohy, zvolená H-sestava a její verze, původní reporty, změna strategie, identifikované nesplněné požadavky, vazby na běhy/Goal Contract, výsledky srovnání a omezení použitelnosti. Zkušenost s jediným úspěchem je kandidát/hypotéza, ne obecně prokázaný zákon.
8. Při příštím podobném promptu může FR zvolit lépe doloženou sestavu a transparentně uvést proč. Opakované pozitivní i negativní důkazy mají upravovat její důvěryhodnost. Zvaž také redukci zbytečných H u úspěšných úloh (stejná kvalita s menší režií).

Navrhni nejjednodušší důvěryhodnou implementaci. Není vyžadováno statisticky dokonalé kauzální dokazování jednotlivých H. Je však zakázáno vydávat pouhou korelaci či jeden šťastný pokus za prokázanou příčinu zlepšení. Podle potřeby použij řízené porovnání jedné změny a odlišuj předběžné a ověřené zkušenosti.

# 2. HRANICE AUTORITY — NIKDY NEUČIT OBCHÁZENÍ CÍLE

Zachovej beze změny tyto principy v0.3.1:

- „Algoritmy řídí, AI interpretuje a tvoří.“
- „Capabilities may grow; authority may not.“
- Fail-closed a transparentní původ úsudku.
- Originální prompt beze změn; Goal Contract zamčený a hashovaný; každá legitimní změna cíle jen verzovaně a explicitně.
- Nezávislé rozhodování A/B/C/D, povinná verifikace, omezený počet oprav.
- Mock není důkaz; žádná API fakturace a žádný automatický placený fallback.

Odděl analytická hlediska od bezpečnostních a smluvních povinností. I pokud profil používá jinou kombinaci H, musejí vždy platit identifikace cíle (H1), systémově skutečné schopnosti (H7), oprávnění (H8), relevantní bezpečnostní/rizikové kontroly (H9) a systémová kritéria Verifieru. Pokud navrhneš elegantnější rozdělení pevných systémových garancí a adaptivních H, je vítáno; jejich pravomoc však nesmí slábnout.

Nepovol změnu povinných akceptačních kritérií pro dosažení PASS. Pokud je hodnotitel nebo kritérium vadné, jde o samostatně verzovanou opravu hodnoticí logiky s historickou evidencí, nikoli o „učení úspěchu“. SYS-4 řeš s ohledem na doložený problém z passportu §6.1; záměna falešného hodnocení a zlepšení H by otrávila celou Knowledge Base.

Stávající limit jedné opravy na větev se nesmí obcházet řetězením interních automatických pokusů. Nové experimenty musí mít explicitně vymezený režim, limity a autorizaci. Dokud uživatel nepovolí dodatečné reálné modelové průchody, ukládej kandidáty a testuj mechanismus bez reálné inference; nevyvolávej je skrytě.

Knowledge Base s uživatelskými prompty, dokumenty, běhy nebo potenciálně citlivými daty musí zůstat lokální a mimo veřejný Git. Do GitHubu lze uložit schémata, kód, dokumentaci a bezpečné syntetické fixtures, nikoli reálnou soukromou historii.

# 3. POŽADAVKY NA KNOWLEDGE BASE A TRANSPARENTNOST

Chci znovupoužitelnou zkušenost, nikoli skládku celých minulých promptů. Urči přiměřené úložiště, migrace/verze, index charakteristiky úloh, pravidla podobnosti a uchovávání důkazů. Nemusíš použít vektorovou databázi ani další jazykový model, pokud je rozumné řešení jednodušší.

U každého převzetí zkušenosti musí být jasné:
- která charakteristika se shodovala a která nikoli;
- jaká analytická sestava byla vybrána a na základě jakých záznamů;
- co je jen návrh, co bylo experimentálně porovnáno a co bylo opakovaně potvrzeno;
- zda byla zvolená zkušenost aktivně použita v promptu, nebo pouze doporučena;
- jaké výsledky podporují či vyvracejí její účinnost.

Zamez přenosu faktů z předchozí uživatelské úlohy do nové jako domněle pravdivého kontextu. Přenášej zkušenost s METODOU, nikoli neověřené faktické závěry z cizích úloh. Při neúplných důkazech preferuj bezpečnou výchozí cestu.

# 4. UŽIVATELSKÉ ROZHRANÍ — CO FR PRÁVĚ DĚLÁ

Současný frontend ukazuje nahoře odpověď, dále fáze a reporty. Doplň srozumitelný ŽIVÝ PROVOZNÍ PRŮBĚH, nikoli pouze konečnou historii. Uživatel má během běhu vidět fakticky doložené kroky:

- co se teď zpracovává (např. profil zadání, výběr H-sestavy, analýza, audit cíle, kompilace, exekuce, ověření, zjištěná odchylka, návrh alternativy, aktualizace znalostí);
- co již skončilo, co běží a co bylo přeskočeno nebo zablokováno;
- časy a případně větev / typ modelového volání, pokud jsou údaje dostupné;
- při učení stručný důvod zvolené sestavy, zda je zkušenost kandidátní či ověřená, a zda byla skutečně uložena.

Pro průběh použij skutečné události/stavy FR Core a stávající perzistentní běhy. Můžeš využít nynější polling nebo navrhnout účinnější přenos; nerozšiřuj systém zbytečně. Procesní informace musí přežít znovuotevření historie. Nezobrazuj interní chain-of-thought, skryté úvahy modelu, tajemství ani smyšlené procentuální odhady. Srozumitelnost je důležitější než zahlcení logy. Čeština v UI.

HLAVNÍ ODPOVĚĎ nahoře musí mít zřetelné MODRÉ vizuální odlišení od analytických reportů (např. modrý okraj, jemně modré pozadí, odpovídající nadpis). Vytvoř promyšlené proměnné barev pro světlý/tmavý režim, dostatečný kontrast a mobilní zobrazení. Barevné významy PASS/PARTIAL/FAIL, simulace a blokací se nesmějí stát nečitelné. Hlavní odpověď musí zůstat nahoře; procesní průběh má být snadno viditelný hned pod ní nebo ve vhodném souvisejícím místě. Neprováděj zbytečný redesign celé aplikace.

# 5. PROMPTS-AS-REPO — SDÍLENÍ ZADÁNÍ MEZI AGENTY

Zaveď jako závaznou pracovní konvenci, že kanonické delší prompty pro CC/CX a další agenty se ukládají do /prompts v TOMTO repozitáři a předávají se krátkým starterem obsahujícím přesnou cestu a očekávaný režim práce.

Pozor: /prompts již existuje a obsahuje prompts/FRANKENSTEIN_v0.3_zadani.md; znovu jej nevytvářej ani nemaž. Ověř existenci a uprav README nebo krátký index v /prompts s jednoduchou konvencí pojmenování, verzování, autority a práce s main. Není potřeba budovat nový prompt-management software. Současný prompt je zde uložen právě jako první takové sdílené zadání pro další fázi.

Nové prompty ukládej v čitelné Markdown podobě bez tajemství, s jasným účelem a odkazem na kanonické zdroje. První řádek každého starteru pro nové vlákno musí být názvem vlákna. Před zahájením práce nový agent vždy ověří aktuální main, aby nepracoval podle zastaralé kopie.

# 6. IMPLEMENTAČNÍ PŘÍSTUP — TVOJE VOLBA

Nechci ti diktovat konkrétní algoritmus podobnosti, pevný počet H, fyzické rozložení modulů ani výběr úložiště. Udělej nejprve stručné technické zhodnocení trade-offů a vyber úsporné řešení s reálnou vazbou napříč příjmem úlohy → analýzou → kompilací → verifikací → učením → dalším během.

Priorita je funkční „vertical slice“: skutečný výběr H podle předchozí zkušenosti a doložený efekt na sestavený prompt, s perzistentním záznamem zkušenosti. Pokud nelze bezpečně dokončit celou bohatší autonomní experimentální část v jednom pracovním běhu, dokonči konzistentní použitelný základ, zbývající omezení přesně popiš a nevydávej kandidátní/hypotetické učení za prokázanou optimalizaci.

Nepřidávej automatické práce mimo toto zadání, přehnané audity, cross-repo procedury ani těžké frameworky. Neprováděj benchmarking BASELINE vs. FR jako samostatný výzkumný proud; ten řeší jiný pracovní postup. Nutné vývojové regresní a integrační testy však patří k této implementaci.

# 7. CO MUSÍ BÝT OVĚŘITELNÉ

Před dokončením bez reálné inference prokaž minimálně:

A. Výchozí v0.3.1 scénáře se nerozbijí (stávající testy + odpovídající nové testy).
B. Pro novou charakteristiku bez zkušeností zvolí FR bezpečnou výchozí H-sestavu.
C. Je možné vytvořit strukturovaný kandidát alternativních H, doložit jeho původ a porovnat výsledky proti stejnému zamčenému Goal Contract a stejným povinným kritériím.
D. Ověřeně uložená vhodná sestava je při příští podobné úloze nalezena a skutečně ovlivní reporty/Execution Contract. Nesouvisející úloha ji nepřevezme.
E. Neúspěch kvůli nemožnému oprávnění či vadnému hodnotiteli se automaticky nevydává za nedostatek H-sestavy.
F. Mock neprodukuje falešné důkazy reálné kvalitativní převahy.
G. Nové průběhové události se zobrazují živě a po znovuotevření. Hlavní odpověď je zřetelně modře odlišena ve světlém i tmavém režimu a zůstává nahoře.
H. Neexistuje nová API fakturace, obcházení limitů, automatická reálná inference ani skryté změny kontraktů.

Uveď rozdíl mezi výsledky deterministických testů toku a skutečným důkazem kvalitativní účinnosti H-sestavy. Jestli bez autorizované reálné inference nelze doložit bod kvalitativní účinnosti, přiznej jej jako čekající ověření, nikoli PASS.

# 8. DOKUMENTACE, COMMITY A PŘEDÁNÍ

Do docs/ ulož srozumitelnou architekturu a principy v0.4, včetně hranice mezi závaznými bezpečnostními pravidly, adaptivními H a ověřováním efektivity. Aktualizuj README a případné schéma/verze/UI popisky. Neoznačuj nedokončenou funkcionalitu za plně implementovanou v0.4.

Pracuj v tomto repozitáři, ověřuj main, udržuj tematicky oddělené změny; po dokončení podle platného postupu commitni a pushni implementaci na main (žádný force push). Pokud je publikace bezpečně blokovaná cizími změnami, nic nepřepisuj a přesně popiš stav a blokaci.

Závěrečný report česky: zvolená architektura a proč; co se FR skutečně naučí a co teprve kandiduje; jak vypadá průchod UI; nové/splněné testy; co nebylo možno ověřit bez inference; spotřeba reálných modelových volání (očekávám nula bez mého souhlasu); přesný Git commit/branch/main a seznam kanonických promptů v /prompts.

Při technických změnách průběžně používej již dohodnuté lifecycle značky a časování (Europe/Prague); uváděj, co se spustilo, co se děje automaticky, kde je nutný ruční zásah a jak se prokáže výsledek. Nevytvářej nové schvalovací checkpointy pro běžné implementační detaily.

Začni kontrolou repozitáře a krátkým návrhem řešení; pokud neexistuje zásadní bezpečnostní či fakturační překážka, pokračuj samostatně až k funkční implementaci.