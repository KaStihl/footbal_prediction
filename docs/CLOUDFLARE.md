# Cloudflare + Access (súkromný prístup)

Stránka je čisto statická (priečinok `site/`), bez build kroku.

## Varianta Workers (aktuálne nastavená)

Worker `footbal-prediction` je pripojený na tento repozitár (Workers Builds). Konfiguráciu má `wrangler.jsonc` v koreni repa: servuje priečinok `site/`.
V dashboarde: Worker → Settings → Build: **Build command** prázdny, **Deploy command** `npx wrangler deploy`, **Production branch** = vetva, na ktorej beží workflow (`claude/football-predictions-html-hsgyxe` alebo `main`).
Súkromie (bez karty, bez Zero Trust): `src/worker.js` pýta HTTP Basic heslo pred každou požiadavkou (aj pred dátami). Heslo je secret `SITE_PASSWORD`:
Worker → **Settings → Variables and Secrets → Add** → Type **Secret**, Variable name `SITE_PASSWORD`, Value = tvoje heslo → **Deploy**. Používateľské meno je ľubovoľné. Kým secret nie je nastavený, stránka vracia 503 (zatvorená).
Cloudflare Access (Zero Trust) je alternatíva, ale vyžaduje platobnú kartu aj pri bezplatnom pláne.

## Varianta Pages

## 1. Pages projekt

1. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git** → vyber repo `KaStihl/footbal_prediction` (pri prvom použití povoľ Cloudflare GitHub appke prístup k repu).
2. **Production branch**: `main` (pozri poznámku o vetve nižšie).
3. **Framework preset**: None · **Build command**: *(prázdne)* · **Build output directory**: `site`.
4. Save and Deploy. Dostaneš adresu `https://<projekt>.pages.dev`.

Keď workflow v Actions pushne nové dáta, Cloudflare nasadí novú verziu automaticky.

## 2. Súkromie (Cloudflare Access, zadarmo do 50 používateľov)

Najjednoduchšie: projekt → **Settings → General → Access policy → Enable** (chráni produkčnú aj preview adresu).

Alebo ručne: **Zero Trust → Access → Applications → Add an application → Self-hosted**
* Application domain: `<projekt>.pages.dev` (pridaj aj `*.<projekt>.pages.dev` pre preview nasadenia)
* Policy: **Allow** · Include: **Emails** → tvoj e-mail
* Identity provider: *One-time PIN* (kód príde e-mailom, nič iné netreba nastavovať)

Odteraz sa pri otvorení stránky (aj JSON dát) zobrazí prihlásenie. Stránka má navyše `noindex` a `robots.txt` Disallow.

## Poznámka k vetve

Plánované workflow (cron) v GitHub Actions bežia len na **predvolenej vetve** repa a Cloudflare produkčne nasadzuje svoju *production branch*. Zlúč vývojovú vetvu do `main` a nastav `main` ako predvolenú (GitHub → Settings → Branches), potom oba fungujú bez ďalších úprav.
