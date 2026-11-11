# Football predictions (súkromné)

Denne aktualizovaná statická stránka s predikciami futbalových zápasov: zaujímavé zápasy európskych líg, víkendové kolo Premier League + Bundesligy a Liga národov. Každý zápas má tip na skóre, pravdepodobnosti 1X2, Over/Under 2,5, BTTS, porovnanie s kurzami a zdôvodnenie, ktoré sa dá skontrolovať.

## Ako to funguje

```
GitHub Actions (cron)                                      Cloudflare Worker (heslo) + statické súbory
 ├─ API-Football  → rozpis, výsledky, xG/strely/držanie, zranenia, kurzy
 ├─ štatistický model (pipeline/model.py)  → xG, pravdepodobnosti, skóre
 ├─ Claude analytici (pipeline/analyst.py) → správy o kádri z webu, ±15 % úprava xG, zdôvodnenie (sk)
 ├─ track record (pipeline/track.py)       → zmrazenie tipu pred výkopom, vyhodnotenie po zápase
 └─ commit  site/data/*.json + state/*.json  ──push──►  nasadí sa statická stránka  site/
```

* **Model** je Poissonov model s časovým vážením a zmrštením (ridge) sily útoku/obrany tímov + Dixon-Coles korekcia nízkych skóre. Kluby a reprezentácie sa fitujú osobitne. Do fitu vstupuje zmes reálnych gólov a xG (alebo odhadu zo striel na bránu, ak xG nie je).
* **Analytici** sú nezávislé volania Claude (jedno na zápas, paralelne), každé s webovým vyhľadávaním. Nikdy nevyrábajú pravdepodobnosti: vrátia ohraničené násobky xG (max ±15 %), zoznam absencií **s odkazom na zdroj a mierou istoty** a slovenské zdôvodnenie. Čísla z toho prepočíta model. Na konci kola píše „hlavný analytik“ prehľad kola.
* Čo nie je dostupné, analytik uvedie v „Čo sa nepodarilo zistiť“, nič nedopĺňa z hlavy.
* **Track record**: tip sa pred výkopom stále prepisuje, po výkope zmrzne a po zápase sa porovná s výsledkom (1X2, presné skóre, Brier skóre, porovnanie s trhom).

## Nastavenie (jednorazovo)

1. **API-Football** – registrácia a kľúč: <https://dashboard.api-football.com/register> (info o plánoch: <https://www.api-football.com/pricing>).
   Free plán má 100 volaní denne; môže byť obmedzený na staršie sezóny. Po registrácii spusti `python -m pipeline doctor`, ktorý overí, či tvoj plán pokrýva aktuálne sezóny.
2. **Anthropic API kľúč** na <https://console.anthropic.com/> (pre analytikov).
3. V GitHub repo → *Settings → Secrets and variables → Actions*:
   * Secrets: `API_FOOTBALL_KEY`, `ANTHROPIC_API_KEY`
   * Variables (voliteľné): `API_FOOTBALL_MAX_CALLS` (na jeden beh; free: 45 = dva behy denne, Pro: napr. 3000), `API_FOOTBALL_RPM` (free: 10, Pro: 300), `ANALYST_MODEL` (predvolene `claude-opus-5-5`; lacnejšie napr. `claude-sonnet-5-5`), `ANALYST_EFFORT` (`low|medium|high`), `ANALYST_MAX_MATCHES` (predvolene 16 na beh), `ANALYST_ALLOWED_DOMAINS` (čiarkami oddelené domény, ak chceš analytika obmedziť len na vybrané weby)
4. **Cloudflare** – Worker `footbal-prediction` je napojený na repo a po každom pushi (aj od bota s novými dátami) sa nasadí sám. Heslo: Worker → Settings → Variables and Secrets → Secret `SITE_PASSWORD`. Podrobnosti v [docs/CLOUDFLARE.md](docs/CLOUDFLARE.md).
5. Spusti workflow **Daily predictions** ručne (*Actions → Daily predictions → Run workflow*). Prvý beh nechaj bez prestávky skontrolovať v logu a v `site/data/meta.json` (pole `warnings`).

Workflow beží denne o 05:30 UTC a vo štvrtok–nedeľu ešte o 09:15 UTC (nové správy o kádri a zostavy). GitHub cron nie je presný, môže meškať.

## Lokálne

```bash
pip install -r requirements.txt
python -m unittest discover -s tests          # testy
python -m pipeline demo                       # fiktívne DEMO dáta → site/data/demo (nie je v gite)
cd site && python -m http.server 8000         # otvor http://localhost:8000/?demo=1
API_FOOTBALL_KEY=... ANTHROPIC_API_KEY=... python -m pipeline run            # reálny beh
API_FOOTBALL_KEY=... python -m pipeline run --no-analyst                     # len štatistický model
```

Ručne pridaný zápas (aj mimo 14-dňového okna): `python -m pipeline find-team "Slovakia"` → `python -m pipeline next-fixtures <team_id>` → ID zapíš do `extra-matches.json` (`fixture_ids`). Objaví sa v záložke Zaujímavé.

## Náklady a limity

* **API-Football** – rozpočet volaní na beh určuje `API_FOOTBALL_MAX_CALLS`. Poradie priorít: rozpisy súťaží, doťahovanie štatistík (max `STATS_MAX_CALLS`=12 volaní na beh), kurzy a zranenia pre zápasy v záložkách. Odpovede sa cachujú (`.cache/api`, ukladá sa cez actions/cache).
* **Anthropic API** – platí sa za tokeny + webové vyhľadávania. Každý beh zapíše spotrebu do `site/data/meta.json` → `analyst.usage`; z prvého behu si spočítaj reálnu cenu. Analytik sa spúšťa len pre zápasy v záložkách do 96 h pred výkopom a len ak sa zmenili vstupy alebo je analýza staršia ako 20 h. Zníž cenu cez `ANALYST_MODEL`, `ANALYST_EFFORT`, `ANALYST_MAX_MATCHES`.
* Ak analytik zlyhá (limit, chyba), stránka ďalej ukazuje čísla zo štatistického modelu a poslednú úspešnú analýzu.
* Ak sa nepodarí stiahnuť žiadne zápasy (zlý kľúč, výpadok API), beh skončí chybou (červený beh v Actions, GitHub pošle e-mail) a predošlé dáta na stránke ostanú nedotknuté.
* Klient API-Football sleduje aj skutočný zvyšok denného limitu (hlavička `x-ratelimit-requests-remaining`) a pred jeho vyčerpaním zastaví.
* Odhad ceny analytika za beh je v `meta.json` → `analyst.est_cost_usd` a zobrazuje sa aj v hlavičke stránky.

## Čo od toho čakať

Trafiť víťaza/remízu sa dá realisticky v ~50–55 % zápasov, presné skóre v ~10–12 %. Bookmakerské kurzy sú zatiaľ najlepší benchmark: sleduj záložku *Track record* a porovnávaj Brier skóre s trhom, kým začneš tipom veriť. Nejde o stávkové rady.
