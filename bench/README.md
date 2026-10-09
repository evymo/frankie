# bench/ — integrační harness FR × modely

Žije **mimo kód FR** (rozhodnutí vlastníka FR 2026-10-09, K3): `src/` z `bench/` nic neimportuje a nenese adresu ani
klíč lane. Harness jen vkládá providera do `runPipeline` zvenku. Kód FR se kvůli němu nemění.

## Obsah

| Soubor | Co dělá |
|---|---|
| `run.js` | Benchmark **FR × samostatný dotaz na tentýž model**. Pro každý scénář a backend spustí celý cyklus FR (`fr`) a čistý dotaz bez obálky FR (`raw`). U STOP scénářů dodá upřesnění a pustí navazující běh. |
| `scenarios.js` | 15 scénářů: `good`, `trap`, `alternative` (A2/B1/D1/C1, poctivost) a `learning` (řízená chyba v 1. exekuci → test opravy). |
| `oracle.js` | Nezávislý orákl: předem známá správná odpověď, jen deterministické kontroly, nikdy kritéria FR. |
| `openaiCompat.js` | Adaptér OpenAI-kompatibilního API (vLLM, Ollama, Docker Model Runner, AISHA /v1). **K9 vynucené:** preflight bez nezávislého soudce (jiný `root` vah) neprojde; výjimka jen výslovně `allowSameJudge: true` → evidence `k9: false`. Evidence nese identitu modelu (served + root), nikdy adresu. Klíč jen z proměnné prostředí. |
| `serve.js` | Lokální UI FR s dalšími modely z `bench/backends.json` (createServer dostane providery zvenku; nedostupné backendy se přeskočí). |
| `report.js` | Report jednoho běhu: správnost, kalibrace verdiktu FR × orákl, učení z chyby, „co kdyby nástroj měl veto“. |
| `compare.js` | Srovnání více běhů v jedné tabulce a matici scénářů. |
| `rescore.js` | Přehodnocení uložených výsledků aktuálním oráklem bez nové inference (originál zůstane v `results.orig.jsonl`). |
| `gpu-harness/` | Harness Učenice: `VllmPrimy` + `SlozenyProvider` (K9), náklady po rolích + ekvivalent API, energie z `nvidia-smi`, suchý běh `--sucho`. K tomu compose testovací aplikace `fr-gpu-test` a scénáře v0.3. |

## Spuštění

```bash
cp bench/backends.example.json bench/backends.json   # lokální, v .gitignore; adresy a modely sem
set -a; . ~/.config/fr/gpu.env; set +a               # FR_GPU_API_KEY mimo repo (soubor s právy 600)
node bench/run.js --only gpu-qwen                     # výsledky do data/bench/<čas>/
node bench/report.js data/bench/<čas>
node bench/compare.js data/bench/<běh-A> data/bench/<běh-B>
FR_CONFIG=data/fr.config.local.json node bench/serve.js   # UI na http://127.0.0.1:4173 s modely z backends.json
npm test                                              # jádro FR + testy bench/ (bez sítě)
node bench/gpu-harness/harness.mjs --frankie . --scenare bench/gpu-harness/scenare.json --out /tmp/x --sucho
```

## Pravidla

- **Sonnet přes `claude-cli` jen jako ruční kalibrace vlastníkem účtu, nejvýš 20 volání** (§5a). Benchmarky se dělají
  jen na vlastních modelech.
- **GPU hostitel je sdílený.** Okno domluvit s koordinátorem GPU a s tím, kdo spravuje `fr-gpu-test`. Na hostiteli
  jen číst, změny dělat jen přes schválenou nasazovací cestu a tunel (jen 127.0.0.1) držet jen po dobu testu. Stop
  pravidlo: jakmile ostatní lane na uzlu nejsou healthy, test zastavit.
- Adresy, porty a jména hostitelů patří jen do lokálního `bench/backends.json` (v `.gitignore`), nikdy do repa.
- Qwen3.x na vLLM bez reasoning-parseru: posílat `chat_template_kwargs: {enable_thinking: false}`, jinak uvažování
  zaplní `content`. V `gpu-harness` je uvažování ve výchozím stavu vypnuté (`--s-uvazovanim` ho zapne).
- Suchý běh `gpu-harness --sucho` ověřuje jen řetězec volání. Verdikty v něm nejsou směrodatné, protože
  `VllmPrimy` hlásí `simulated: false` i nad mockem.

Výsledky prvního měření: [`docs/BENCH-2026-10-09.md`](../docs/BENCH-2026-10-09.md).
