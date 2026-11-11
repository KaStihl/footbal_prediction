# Cloudflare (Worker `footbal-prediction`)

Všetko beží v jednom Workeri, ktorý je napojený na tento repozitár (Workers Builds). Po každom pushi do vetvy `claude/football-predictions-html-hsgyxe` sa nasadí sám.

## Nastavenie buildu (Worker → Settings → Build)
* Root directory: `/` · Build command: *(prázdne)* · Deploy command: `npx wrangler deploy`
* Branch control → Production branch: `claude/football-predictions-html-hsgyxe`

## Secrets (Worker → Settings → Variables and Secrets → Add → Type: **Secret**)
| Názov | Hodnota |
|---|---|
| `SITE_PASSWORD` | heslo k stránke (meno pri prihlásení je ľubovoľné) |
| `API_FOOTBALL_KEY` | kľúč z https://dashboard.api-football.com |
| `ANTHROPIC_API_KEY` | kľúč z https://console.anthropic.com (bez neho beží len štatistický model) |

## Voliteľné premenné (Type: **Text**)
| Názov | Predvolené | Význam |
|---|---|---|
| `EXTRA_FIXTURE_IDS` | – | ručne pridané zápasy, ID oddelené čiarkou (zistíš cez `/api/find-fixtures?team=Názov`) |
| `ANALYST_MODEL` | `claude-opus-5-5` | lacnejšie napr. `claude-sonnet-5-5` |
| `ANALYST_EFFORT` | `medium` | `low` / `medium` / `high` |
| `ANALYST_MAX_MATCHES` | `16` | max. počet analýz na jeden beh |
| `API_FOOTBALL_MAX_CALLS` | `45` | volaní API-Football na beh (free plán: 100/deň) |
| `API_FOOTBALL_RPM` | `10` | volaní za minútu (free: 10, Pro: 300) |
| `ANALYST_ALLOWED_DOMAINS` | – | obmedzí webové vyhľadávanie analytika na tieto domény |

Premenné pridané v dashboarde môže ďalší deploy z repa prepísať, iba ak sú definované aj vo `wrangler.jsonc` (tam nie sú, takže ostanú). Secrets ostávajú vždy.

## Plánovanie
`wrangler.jsonc` → `triggers.crons`: denne 05:30 UTC a štvrtok až nedeľa 09:15 UTC. Ručne: tlačidlo **Prepočítať teraz** na stránke.

## Free plán
Worker na free pláne má limit ~10 ms CPU na jedno spustenie. Výpočet je preto rozdelený na ~80–110 malých krokov (Durable Object + alarmy), každý s malou spotrebou CPU (čakanie na API sa nepočíta). Krok, ktorý limit prekročí 2×, sa preskočí a zapíše sa do upozornení na stránke. Ak by sa to opakovalo (napr. „krok rows … preskočený“), pomôže Workers Paid (5 USD/mes., limit 30 s).
