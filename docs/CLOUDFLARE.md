# Cloudflare (Worker `footbal-prediction`)

Všetko beží v jednom Workeri, ktorý je napojený na tento repozitár (Workers Builds). Po každom pushi do vetvy `claude/football-predictions-html-hsgyxe` sa nasadí sám.

## Nastavenie buildu (Worker → Settings → Build)
* Root directory: `/` · Build command: *(prázdne)* · Deploy command: `npx wrangler deploy`
* Branch control → Production branch: `claude/football-predictions-html-hsgyxe`

## Secrets (Worker → Settings → Variables and Secrets → Add → Type: **Secret**)
| Názov | Hodnota |
|---|---|
| `SITE_PASSWORD` | heslo k stránke (meno pri prihlásení je ľubovoľné) |
| `ANTHROPIC_API_KEY` | kľúč z https://console.anthropic.com (bez neho beží len štatistický model) |
| `FOOTBALL_DATA_KEY` | voliteľný, bezplatný kľúč z https://www.football-data.org/client/register (záloha, keď ESPN zlyhá) |
| `API_FOOTBALL_KEY` | voliteľný (posledná záloha; free plán má len sezóny do 2024) |

## Voliteľné premenné (Type: **Text**)
| Názov | Predvolené | Význam |
|---|---|---|
| `EXTRA_FIXTURE_IDS` | – | pripnuté zápasy, ID oddelené čiarkou (zistíš cez `/api/find-fixtures?team=Názov`) |
| `ANALYST_MODEL` | `claude-sonnet-5-5` | presnejší a drahší `claude-opus-5-5` |
| `ANALYST_EFFORT` | `medium` | `low` / `medium` / `high` |
| `ANALYST_MAX_MATCHES` | `16` | max. počet analýz na jeden beh |
| `API_FOOTBALL_MAX_CALLS` | `45` | volaní API-Football na beh (free plán: 100/deň) |
| `API_FOOTBALL_MAX_SEASON` | `2024` | najnovšia sezóna, ktorú tvoj plán API-Football vydá (platený plán: napr. `2030`) |
| `ANALYST_ALLOWED_DOMAINS` | – | obmedzí webové vyhľadávanie analytika na tieto domény |

Premenné pridané v dashboarde môže ďalší deploy z repa prepísať, iba ak sú definované aj vo `wrangler.jsonc` (tam nie sú, takže ostanú). Secrets ostávajú vždy.

## Plánovanie
`wrangler.jsonc` → `triggers.crons`: denne 05:30 UTC a štvrtok až nedeľa 09:15 UTC. Ručne: tlačidlo **Prepočítať teraz** na stránke.

## Zdroje dát (reťazec)
1. **ESPN** (bez kľúča, neoficiálne verejné JSON): rozpis, výsledky, štatistiky zápasov (strely, strely na bránu, držanie lopty) a kurzy DraftKings, mesiac po mesiaci.
2. **football-data.org** (bezplatný kľúč): keď ESPN pre súťaž a sezónu zlyhá alebo nič nevráti.
3. **API-Football**: posledná záloha.
Ktorý zdroj sa použil, je na stránke v „Zdroje dát“.

## Free plán
Worker na free pláne má limit ~10 ms CPU na jedno spustenie. Výpočet je preto rozdelený na ~80–110 malých krokov (Durable Object + alarmy), každý s malou spotrebou CPU (čakanie na API sa nepočíta). Krok, ktorý limit prekročí 2×, sa preskočí a zapíše sa do upozornení na stránke. Ak by sa to opakovalo (napr. „krok rows … preskočený“), pomôže Workers Paid (5 USD/mes., limit 30 s).
