# Football predictions (súkromné)

Súkromná stránka s predikciami futbalových zápasov: zaujímavé zápasy európskych líg, víkendové kolo Premier League + Bundesligy a Liga národov. Pri každom zápase je tip na skóre, pravdepodobnosti 1X2, Over/Under 2,5, BTTS, porovnanie s kurzami a zdôvodnenie, ktoré sa dá skontrolovať. Záložka *Track record* porovnáva tipy so skutočnými výsledkami.

## Architektúra (všetko v Cloudflare, bez GitHub Actions)

```
Cloudflare Worker "footbal-prediction"
 ├─ heslo (HTTP Basic, secret SITE_PASSWORD) pred všetkým
 ├─ statická stránka  site/
 ├─ /data/*.json      výstupy z Durable Object
 ├─ /api/run, /api/status, /api/find-fixtures
 └─ Cron (05:30 UTC denne, Št–Ne aj 09:15 UTC) ─► Durable Object "Pipeline"
        krok po kroku (alarmy, každý krok pár ms CPU):
        API-Football: zápasy, štatistiky (xG, strely, držanie lopty), kurzy, zranenia
        → štatistický model → výber zápasov do záložiek → Claude analytici → zverejnenie
```

* **Model** (`src/model.js`): Poissonov model s časovým vážením a zmrštením sily útoku/obrany tímov + Dixon-Coles korekcia nízkych skóre. Kluby a reprezentácie sa fitujú osobitne. Vstupom je zmes gólov a xG (alebo odhadu zo striel na bránu). Fit je inkrementálny, pokračuje z včerajších parametrov.
* **Analytici** (`src/analyst.js`): na každý zápas jedno volanie Claude s webovým vyhľadávaním (správy klubov, tlačové konferencie, médiá). Vrátia ohraničenú úpravu xG (max ±15 %), absencie **so zdrojom a mierou istoty** a slovenské zdôvodnenie. Pravdepodobnosti prepočíta model. Analytik sa spustí znova len pri vecnej zmene (posun modelu o viac ako 3 p. b., nové zranenia, zmena výkopu) alebo keď je analýza staršia ako 20 h. Na konci kola „hlavný analytik“ napíše prehľad.
* **Track record** (`src/track.js`): tip sa pred výkopom zmrazí a po zápase vyhodnotí (1X2, presné skóre, Brier skóre, porovnanie s trhom).

Nastavenie Workera (secrets, premenné, build) je v [docs/CLOUDFLARE.md](docs/CLOUDFLARE.md).

## Ovládanie

* **Prepočítať teraz**: tlačidlo v hlavičke stránky spustí výpočet hneď. Priebeh sa ukazuje pod nadpisom. Prvý beh trvá niekoľko minút (sťahujú sa celé sezóny).
* **Ručne pridaný zápas**: otvor `https://<stránka>/api/find-fixtures?team=Slovakia`, skopíruj `fixture_id` a pridaj ho do premennej `EXTRA_FIXTURE_IDS` vo Workeri (čiarkami oddelené). Zápas sa ukáže v záložke Zaujímavé, aj keď je ďalej ako 14 dní (do 60 dní).
* **Upozornenia** z posledného behu (chýbajúca sezóna v pláne API, vyčerpaný limit, preskočený krok) sú dole na stránke.

## Vývoj

```bash
npm install
npm test                               # unit + end-to-end testy s falošným API a falošným Claude
npx wrangler dev                       # lokálne (secrets do .dev.vars, nie je v gite)
```

## Náklady a limity

* **API-Football**: rozpočet na beh `API_FOOTBALL_MAX_CALLS` (predvolene 45). Klient sleduje aj skutočný zvyšok denného limitu a pred jeho vyčerpaním zastaví. Rozpisy sa ukladajú (aktuálna sezóna sa obnovuje po 3 h, minulá po 7 dňoch).
* **Anthropic API**: odhad ceny posledného behu je v hlavičke stránky aj v `/data/meta.json` (`analyst.est_cost_usd`). Lacnejšie cez `ANALYST_MODEL`, `ANALYST_EFFORT` a `ANALYST_MAX_MATCHES`.
* **Cloudflare free plán**: ~10 ms CPU na spustenie. Kroky sú navrhnuté pod týmto limitom. Ak by sa niektorý opakovane preskakoval, je to v upozorneniach a pomôže Workers Paid.
* Keď API nevráti nič, publikované dáta sa neprepíšu prázdnymi.

## Čo od toho čakať

Trafiť víťaza/remízu sa dá realisticky v ~50–55 % zápasov, presné skóre v ~10–12 %. Bookmakerské kurzy sú najlepší benchmark, preto porovnávaj Brier skóre s trhom v *Track record*. Nejde o stávkové rady.
