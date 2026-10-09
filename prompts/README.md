# /prompts — sdílená kanonická zadání (prompts-as-repo)

Závazná pracovní konvence projektu FRANKENSTEIN: **delší zadání pro agenty (CC = Claude Code, CX = Codex a další) žijí
v tomto adresáři na větvi `main`.** Do nového vlákna se nepředává celý text, ale krátký **starter** s přesnou cestou
a očekávaným režimem práce. Repozitář je veřejný — žádná tajemství, osobní údaje ani data běhů.

## Pojmenování

```
FRANKENSTEIN_v<verze>_<téma>[_<agent>].md
```
- `<verze>` — cílová verze FR (`v0.3`, `v0.4`, …), `<téma>` — krátce, snake_case, bez diakritiky,
- `<agent>` — volitelně `CC`, `CX`, … pokud je zadání určené konkrétnímu agentovi.
- Příklad: `FRANKENSTEIN_v0.4_adaptive_h_learning_ui_CC.md`.

## Verzování a autorita

- Kanonická je **vždy verze na `main`**. Lokální kopie, přílohy a texty v chatu jsou jen odkazy.
- Zadání se po předání **nepřepisuje potichu**. Věcná změna = nový soubor s vyšší verzí nebo tématem, případně doplněk
  `…_amendment_<n>.md` odkazující na původní zadání. Oprava překlepu je v pořádku (vlastní commit).
- Pořadí autority při rozporu: bezpečnostní a fakturační pravidla projektu (PASSPORT, tento README) → kanonické zadání
  na `main` → starter → pokyny v průběhu práce od Martina.
- Každé zadání uvádí účel, odkazy na kanonické zdroje (PASSPORT, předchozí zadání, kód) a co je mimo rozsah.

## Starter pro nové vlákno

**První řádek je název vlákna.** Následuje přesná cesta a režim práce, nic dalšího není nutné:

```
FRANKENSTEIN v0.X — <téma>

Pracuj v repozitáři `evymo/frankie`, větev `main`.
Nejprve ověř aktuální stav `main` (git fetch / log / status), abys nepracoval podle zastaralé kopie.
Načti a realizuj kanonické zadání: `prompts/<soubor>.md`.
Režim: <implementace | oponentura | analýza>; dodrž bezpečnostní omezení (bez reálné inference a restartu serveru
bez souhlasu). Po dokončení testy, tematický commit, push na `main` a český závěrečný report s commit SHA.
```

## Práce s `main`

1. Před začátkem: `git fetch`, fast-forward `main`, kontrola pracovního stromu; cizí rozpracované změny nepřepisovat.
2. Commity tematicky oddělené, žádný force push. Zadání se commituje samostatně (`docs(prompts): …`).
3. Když publikaci blokují cizí změny, nic se nepřepisuje — popíše se stav a blokace.

## Index

| Soubor | Účel | Agent | Stav |
|---|---|---|---|
| [`FRANKENSTEIN_v0.3_zadani.md`](FRANKENSTEIN_v0.3_zadani.md) | v0.3 — samostatný autonomní cyklus úlohy (Gate 0, Goal Audit, A/B/C/D, Goal Contract, Prompt Compiler, Verifier) | CC | realizováno ve v0.3.1 |
| [`FRANKENSTEIN_v0.4_adaptive_h_learning_ui_CC.md`](FRANKENSTEIN_v0.4_adaptive_h_learning_ui_CC.md) | v0.4 — adaptivní učení H-sestav, živý průběh v UI, modrá hlavní odpověď, prompts-as-repo | CC | realizováno ve v0.4.0 ([architektura](../docs/ARCHITEKTURA-v0.4.md)); kvalitativní účinnost čeká na reálné experimenty |
