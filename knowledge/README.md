# knowledge/ — sdílená Knowledge Base FRANKENSTEIN

Zkušenosti FR s analytickými sestavami hledisek (H-sestavami), které sdílí celý tým přes Git.
Architektura a pravidla učení: [`docs/ARCHITEKTURA-v0.4.md`](../docs/ARCHITEKTURA-v0.4.md).

## Co tu je (a co tu NIKDY není)

Repozitář je **veřejný**. KB proto obsahuje jen **metodu**:
- kategorický profil úlohy (povaha, artefakt, jazyk, omezení, …), použitou H-sestavu a stopu do promptu,
- diagnózu (ID kritérií, typ kontroly, třída příčiny), verdikty, kandidátní změny sestav, řízená srovnání a pozorování,
- ID běhů (jen odkaz — plný běh zůstává u toho, kdo ho spustil).

**Nikdy:** text zadání, výstupy modelu, hash zadání, osobní údaje, tajemství. Ukládání hlídá kód (`sanitizeExperience`)
i test „KB v repozitáři: … bez textu zadání, výstupu i hashe zadání“.

## Struktura (fr-kb/2, append-only)

```
knowledge/
  kb.json              manifest (verze schématu); neznámá verze = FR KB nepoužije ani nepřepíše
  sets/                H-sestavy, název = ID odvozené z hashe obsahu (stejná sestava = stejný soubor)
  recommendations/     definice kandidátů (změna sestavy + podmínky použitelnosti)
  proposals/           každý návrh kandidáta z konkrétního běhu
  experiences/         zkušenost z každého dokončeného běhu
  comparisons/         řízená srovnání (experimenty) — jediný zdroj, který může zvýšit důvěryhodnost
  observations/        pozorování při aktivním použití ověřené zkušenosti (důvěru mohou jen snížit)
```

Každý záznam je samostatný soubor s jedinečným ID a **nikdy se nepřepisuje**. Stav důvěryhodnosti (kandidát →
podpořeno → ověřeno / sporné / vyvráceno) se neukládá — FR ho dopočítá při každém načtení ze všech srovnání.
Pokud stejnou hypotézu nezávisle navrhnou dva lidé, FR je při načtení sloučí pod starší záznam a důkazy sečte.
Díky tomu se změny kolegů v Gitu slučují bez konfliktů.

## Práce v týmu

```bash
git pull                      # před prací: zkušenosti kolegů (FR je načte při dalším běhu, server se nerestartuje)
# … běhy ve FR (UI) — nové záznamy se zapíšou sem …
git add knowledge
git commit -m "knowledge: zkušenosti z běhů <datum>"
git pull --rebase && git push
```

- Záznamy ručně neupravujte ani nemažte. Oprava = nový záznam; chybný záznam řešte samostatným, zdůvodněným commitem.
- Reálné experimenty (stojí volání Claude CLI) se povolují v `config/fr.config.json → learning.realExperiments`
  a každý se potvrzuje v UI. Simulované (mock) záznamy se v KB evidují, ale do důvěryhodnosti se nezapočítávají.
- Prohlížení: v UI panel **Znalostní báze → Zkušenosti a H-sestavy**, karta **Učení a analytická sestava** u běhu,
  nebo `GET http://127.0.0.1:4173/api/kb`.
