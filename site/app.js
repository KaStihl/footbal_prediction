"use strict";
(() => {
  const base = "data/";
  const $app = document.getElementById("app");
  const TABS = ["interesting", "weekend", "nations_league", "track"];
  let state = { pred: null, meta: null, track: null };

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pct = (p) => `${Math.round(p * 100)} %`;
  const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "");
  const fmtTime = (iso) => new Intl.DateTimeFormat("sk-SK", { weekday: "short", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Bratislava" }).format(new Date(iso));
  const dayKey = (iso) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Bratislava" }).format(new Date(iso));
  const dayLabel = (key) => new Intl.DateTimeFormat("sk-SK", { weekday: "long", day: "numeric", month: "long" }).format(new Date(key + "T12:00:00"));
  const ago = (iso) => {
    const h = (Date.now() - new Date(iso)) / 36e5;
    return h < 1 ? "pred chvíľou" : h < 48 ? `pred ${Math.round(h)} h` : `pred ${Math.round(h / 24)} dňami`;
  };
  const SRC = { club_official: "oficiálny web klubu", league_official: "oficiálny web ligy", media: "médiá", api_football: "API-Football", unknown: "zdroj nezistený" };
  const ST = { out: "vypadnutý", doubtful: "pochybný", suspended: "trest", returning: "vracia sa" };
  const CONF = { high: "vysoká", medium: "stredná", low: "nízka" };

  async function getJson(name) {
    const r = await fetch(base + name, { cache: "no-cache" });
    if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
    return r.json();
  }

  async function load() {
    try {
      const [pred, meta, track] = await Promise.all([getJson("predictions.json"), getJson("meta.json"), getJson("track.json")]);
      state = { pred, meta, track };
      document.getElementById("demo-banner").hidden = !meta.demo;
      const an = meta.analyst || {};
      const cost = an.est_cost_usd != null && an.matches_analysed_this_run ? ` (~${an.est_cost_usd.toFixed(2)} USD)` : "";
      document.getElementById("stamp").textContent = `Aktualizované ${ago(meta.generated_at)} · ` +
        (an.enabled ? `analytik: ${an.matches_analysed_this_run} zápasov${cost}` : "bez analytika");
      render();
    } catch (e) {
      $app.innerHTML = `<div class="empty"><p><b>Zatiaľ nie sú dáta.</b></p><p>Klikni na „Prepočítať teraz“. Prvý výpočet trvá niekoľko minút (sťahujú sa celé sezóny a analytik číta správy o tímoch).</p><p class="muted">${esc(e.message)}</p></div>`;
    }
  }

  // ---- run control ---------------------------------------------------------
  const $run = document.getElementById("run-btn");
  const $prog = document.getElementById("run-status");
  let polling = null;
  const STEP = { fixtures: "sťahujem zápasy", extras: "ručne pridané zápasy", stats: "štatistiky zápasov", rows: "príprava dát", fit: "počítam model",
    plan: "vyberám zápasy", entries: "forma a vzájomné zápasy", odds: "kurzy", inj: "zranenia", analyst_plan: "plán analytika",
    analyst: "analytik číta správy", round: "prehľad kola", publish: "zverejňujem" };

  function showStatus(s) {
    if (!s || !s.id || s.done) {
      $run.disabled = false;
      $prog.textContent = s && s.done && s.warnings ? `Posledný beh: ${s.warnings} upozornení` : "";
      return false;
    }
    $run.disabled = true;
    $prog.textContent = `Prebieha výpočet: krok ${s.step + 1}/${s.steps} (${STEP[s.current] || s.current}) · analytik ${s.analysed}`;
    return true;
  }

  async function poll() {
    try {
      const s = await (await fetch("api/status", { cache: "no-store" })).json();
      const running = showStatus(s);
      if (!running && polling) { clearInterval(polling); polling = null; load(); }
      if (running && !polling) polling = setInterval(poll, 4000);
    } catch { /* ignore transient errors */ }
  }

  $run.addEventListener("click", async () => {
    $run.disabled = true;
    try {
      const r = await (await fetch("api/run", { method: "POST" })).json();
      showStatus(r.job);
      if (!polling) polling = setInterval(poll, 4000);
    } catch (e) {
      $prog.textContent = `Nepodarilo sa spustiť: ${e.message}`;
      $run.disabled = false;
    }
  });

  // ---- building blocks -----------------------------------------------------
  function formChips(f) {
    if (!f || !f.last.length) return '<span class="muted">bez dát</span>';
    return `<span class="form">${f.last.map((r) => `<i class="${r.res}" title="${esc(r.date)} ${esc(r.home ? "doma" : "vonku")} vs ${esc(r.opp)} ${esc(r.score)}">${r.res === "W" ? "V" : r.res === "D" ? "R" : "P"}</i>`).join("")}</span>`;
  }

  function teamStats(f) {
    if (!f || !f.games) return "";
    const bits = [`${f.gf}:${f.ga} gólov/zápas`];
    if (f.xg_for != null) bits.push(`xG ${f.xg_for}:${f.xg_against ?? "?"}`);
    if (f.sot != null) bits.push(`${f.sot} striel na bránu`);
    if (f.possession != null) bits.push(`${Math.round(f.possession)} % lopta`);
    return bits.join(" · ");
  }

  function oddsBlock(e) {
    const o = e.odds;
    if (!o) return "";
    const f = e.final, edge = o.edge || {};
    const rows = [["1", "home", f.p_home], ["X", "draw", f.p_draw], ["2", "away", f.p_away]];
    const cells = rows.map(([lab, k, p]) => {
      const d = (edge[k] ?? 0) * 100;
      const cls = d >= 6 ? "edge-pos" : d <= -6 ? "edge-neg" : "";
      return `${lab}: <b>${o[k].toFixed(2)}</b> (trh ${pct(o.implied[k])}, model ${pct(p)}, <span class="${cls}">${d >= 0 ? "+" : ""}${d.toFixed(0)} p. b.</span>)`;
    });
    const value = rows.filter(([, k]) => (edge[k] ?? 0) >= 0.06).map(([lab]) => lab);
    return `<div class="odds"><div>Kurzy ${esc(o.bookmaker)} · marža ${(o.margin * 100).toFixed(1)} %</div><div>${cells.join(" &nbsp;|&nbsp; ")}</div>${value.length ? `<div class="edge-pos">Model vidí vyššiu šancu ako trh: ${value.join(", ")}</div>` : ""}</div>`;
  }

  function whyBlock(e, open) {
    const a = e.analyst;
    const inj = e.injuries || [];
    let html = "";
    if (a) {
      html += `<p>${esc(a.summary)}</p>`;
      const dh = a.xg_mult_home, da = a.xg_mult_away;
      if (Math.abs(dh - 1) > 0.004 || Math.abs(da - 1) > 0.004) {
        html += `<p class="muted">Úprava analytika: xG domáci ×${dh.toFixed(2)}, hostia ×${da.toFixed(2)} (model samotný: ${e.model.score}, ${pct(e.model.p_home)}/${pct(e.model.p_draw)}/${pct(e.model.p_away)}).</p>`;
      }
      if (a.key_factors.length) {
        html += `<h4>Kľúčové faktory</h4><ul class="plain">${a.key_factors.map((k) => `<li><b>${esc(k.factor)}</b> <span class="muted">(${k.favours === "home" ? "domáci" : k.favours === "away" ? "hostia" : "neutrálne"})</span>: ${esc(k.detail)}</li>`).join("")}</ul>`;
      }
      if (a.absences.length) {
        html += `<h4>Absencie a správy o kádri</h4><ul class="plain">${a.absences.map((x) => {
          const u = safeUrl(x.source_url);
          const src = u ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(SRC[x.source_type] || "zdroj")}</a>` : esc(SRC[x.source_type] || "bez zdroja");
          return `<li>${esc(x.player)} (${x.team === "home" ? esc(e.home.name) : esc(e.away.name)}): ${esc(ST[x.status] || x.status)} · ${src}<span class="badge ${esc(x.confidence)}">istota: ${esc(CONF[x.confidence] || x.confidence)}</span></li>`;
        }).join("")}</ul>`;
      }
      if (a.data_gaps.length) html += `<h4>Čo sa nepodarilo zistiť</h4><ul class="plain">${a.data_gaps.map((g) => `<li>${esc(g)}</li>`).join("")}</ul>`;
      html += `<p class="muted">Zostavy ${a.lineups_confirmed ? "potvrdené" : "zatiaľ nepotvrdené"} · analýza ${ago(a.updated_at)}${a.stale ? " (zastaraná)" : ""}</p>`;
    } else {
      html += `<p class="muted">Analytik tento zápas ešte neprepočítal (spúšťa sa pár dní pred výkopom). Čísla vychádzajú len zo štatistického modelu.</p>`;
    }
    if (inj.length && !(a && a.absences.some((x) => x.source_type === "api_football"))) {
      html += `<h4>Zranenia podľa API-Football</h4><ul class="plain">${inj.map((i) => `<li>${esc(i.player)} <span class="muted">(${esc(i.reason || i.type || "")})</span></li>`).join("")}</ul>`;
    }
    const f = e.form, h = e.h2h;
    html += `<div class="grid2"><div><h4>${esc(e.home.name)}: forma</h4>${formChips(f.home)}<div class="muted">${esc(teamStats(f.home))}</div></div>
      <div><h4>${esc(e.away.name)}: forma</h4>${formChips(f.away)}<div class="muted">${esc(teamStats(f.away))}</div></div></div>`;
    if (h && h.n) {
      html += `<h4>Vzájomné zápasy (posledných ${h.n})</h4><div>${esc(e.home.name)} ${h.home_wins}V · ${h.draws}R · ${h.away_wins}P · góly ${h.goals_home_team}:${h.goals_away_team}</div><div class="muted">${h.matches.map((m) => `${esc(m.date)} ${esc(m.home)} ${esc(m.score)} ${esc(m.away)}`).join(" | ")}</div>`;
    }
    const lead = `<summary>${open ? "Zdôvodnenie" : "Zdôvodnenie a podrobnosti"}</summary>`;
    return `<details class="why" ${open ? "open" : ""}>${lead}${html}</details>`;
  }

  function card(e, open) {
    const f = e.final, rk = (t) => (t.table ? `${t.table.rank}. miesto · ${t.table.points} b.` : "");
    const conf = { low: "nízka istota", medium: "stredná istota", high: "vysoká istota" }[f.confidence];
    const [sh, sa] = f.score.split("-");
    const w = (p) => Math.max(p * 100, 0);
    return `<article class="card" data-id="${e.id}">
      <div class="meta"><span>${esc(e.competition)}</span>${e.group ? `<span>${esc(e.group)}</span>` : ""}${e.round ? `<span>${esc(e.round)}</span>` : ""}<span class="sp"></span><span>${esc(fmtTime(e.kickoff))}</span></div>
      <div class="teams">
        <div class="team">${esc(e.home.name)}<small>${esc(rk(e.home))}</small></div>
        <div class="score" aria-label="Tip ${esc(sh)} ku ${esc(sa)}">${esc(sh)} : ${esc(sa)}<small>TIP</small></div>
        <div class="team away">${esc(e.away.name)}<small>${esc(rk(e.away))}</small></div>
      </div>
      <div class="bar" role="img" aria-label="Pravdepodobnosť: domáci ${pct(f.p_home)}, remíza ${pct(f.p_draw)}, hostia ${pct(f.p_away)}">
        <span class="h" style="width:${w(f.p_home)}%">${f.p_home >= .1 ? pct(f.p_home) : ""}</span>
        <span class="d" style="width:${w(f.p_draw)}%">${f.p_draw >= .1 ? pct(f.p_draw) : ""}</span>
        <span class="a" style="width:${w(f.p_away)}%">${f.p_away >= .1 ? pct(f.p_away) : ""}</span>
      </div>
      <div class="chips">
        <span class="chip">xG ${f.xg_home.toFixed(2)} : ${f.xg_away.toFixed(2)}</span>
        <span class="chip">Nad 2,5: ${pct(f.p_over25)}</span>
        <span class="chip">Oba skórujú: ${pct(f.p_btts)}</span>
        <span class="chip">Ďalšie skóre: ${f.top_scores.slice(1).map((s) => esc(s.score) + " (" + pct(s.p) + ")").join(", ")}</span>
        <span class="chip ${f.confidence}">${conf}</span>
        ${e.analyst ? '<span class="chip">model + analytik</span>' : '<span class="chip">len model</span>'}
        ${e.extra ? '<span class="chip">ručne pridaný</span>' : ""}
      </div>
      ${oddsBlock(e)}
      ${whyBlock(e, open)}
    </article>`;
  }

  function roundSummary(tab) {
    const r = (state.meta.round_summaries || {})[tab];
    if (!r) return "";
    const byId = Object.fromEntries(state.pred.matches.map((m) => [m.id, m]));
    const picks = r.top_picks.map((p) => {
      const m = byId[p.match_id];
      return `<li><b>${m ? esc(m.home.name) + " – " + esc(m.away.name) : "Zápas"}</b>: ${esc(p.comment)}</li>`;
    }).join("");
    return `<section class="card summary-card"><h3>Prehľad kola: ${esc(r.title)}</h3><p>${esc(r.overview)}</p>${picks ? `<ul class="plain">${picks}</ul>` : ""}
      ${r.risks.length ? `<h4 class="muted">Najneistejšie</h4><ul class="plain">${r.risks.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}</section>`;
  }

  function playedBlock(tab) {
    const rows = (state.pred.played || []).filter((p) => (p.tabs || []).includes(tab));
    if (!rows.length) return "";
    const body = rows.map((p) => {
      const res = p.result ? `${p.result.hg}-${p.result.ag}` : "–";
      const o = p.result ? (p.result.hg > p.result.ag ? 0 : p.result.hg === p.result.ag ? 1 : 2) : null;
      const probs = [p.pred.p_home, p.pred.p_draw, p.pred.p_away];
      const pick = probs.indexOf(Math.max(...probs));
      const mark = o === null ? "" : pick === o ? '<span class="ok">✓ výsledok</span>' : '<span class="no">✗ výsledok</span>';
      const exact = p.result && p.pred.score === res ? ' <span class="ok">✓ presné skóre</span>' : "";
      return `<tr><td>${esc(fmtTime(p.kickoff))}</td><td>${esc(p.home)} – ${esc(p.away)}</td><td>${esc(p.pred.score)}</td><td><b>${esc(res)}</b></td><td>${mark}${exact}</td></tr>`;
    }).join("");
    return `<h2>Odohrané: tip vs. realita</h2><div class="table-wrap played"><table><thead><tr><th>Výkop</th><th>Zápas</th><th>Tip</th><th>Výsledok</th><th></th></tr></thead><tbody>${body}</tbody></table></div>`;
  }

  // ---- tabs ----------------------------------------------------------------
  function listOf(tab) { return state.pred.matches.filter((m) => m.tabs.includes(tab)).sort((a, b) => a.kickoff.localeCompare(b.kickoff)); }
  const empty = (msg) => `<div class="empty">${msg}</div>`;

  function renderInteresting() {
    const ms = listOf("interesting");
    if (!ms.length) return empty("V najbližších dňoch nie sú zaujímavé zápasy (reprezentačná prestávka?).");
    let html = "", last = "";
    for (const m of ms) {
      const k = dayKey(m.kickoff);
      if (k !== last) { html += `<div class="day">${esc(dayLabel(k))}</div>`; last = k; }
      html += card(m, false);
    }
    return html;
  }

  function renderWeekend() {
    const ms = listOf("weekend");
    const w = state.meta.weekend;
    let html = `<h2>Víkendové kolo ${esc(w.label)} <span class="count">Premier League + Bundesliga</span></h2>`;
    if (!ms.length) return html + empty("V najbližších 3 víkendoch nie sú v rozpise zápasy PL/BL.");
    html += roundSummary("weekend");
    for (const comp of ["premier_league", "bundesliga"]) {
      const c = ms.filter((m) => m.comp === comp);
      if (!c.length) continue;
      html += `<h2>${esc(c[0].competition)} <span class="count">${c.length} zápasov</span></h2>` + c.map((m) => card(m, true)).join("");
    }
    return html + playedBlock("weekend");
  }

  function renderNations() {
    const ms = listOf("nations_league");
    let html = "<h2>Liga národov <span class=\"count\">najbližšie kolá</span></h2>";
    if (!ms.length) return html + empty("V rozpise nie je nadchádzajúce kolo Ligy národov.");
    html += roundSummary("nations_league");
    const rounds = [...new Set(ms.map((m) => m.round))];
    rounds.forEach((r, i) => {
      const items = ms.filter((m) => m.round === r);
      const inner = items.map((m) => card(m, true)).join("");
      html += i === 0 ? `<h2>${esc(r)} <span class="count">${items.length} zápasov</span></h2>${inner}`
        : `<details ${items.some((m) => m.analyst) ? "open" : ""}><summary>${esc(r)} (${items.length} zápasov)</summary>${inner}</details>`;
    });
    return html + playedBlock("nations_league");
  }

  function renderTrack() {
    const t = state.track, o = t.overall || { n: 0 };
    if (!o.n) return empty(`Zatiaľ nie je čo vyhodnotiť. Predikcie sa zmrazia pred výkopom a po zápase sa porovnajú s výsledkom (čakajúce: ${t.pending || 0}).`);
    const mk = o.market;
    const kpi = (v, l) => `<div class="kpi"><div class="v">${v}</div><div class="l">${l}</div></div>`;
    let html = `<h2>Presnosť predikcií</h2><div class="kpis">
      ${kpi(o.n, "vyhodnotených zápasov")}${kpi(pct(o.hit_1x2), "trafený výsledok 1X2" + (mk ? ` (trh ${pct(mk.hit_1x2)})` : ""))}
      ${kpi(pct(o.hit_exact), "trafené presné skóre")}${kpi(o.brier.toFixed(3), "Brier skóre" + (mk ? ` (trh ${mk.brier.toFixed(3)})` : "") + ", nižšie = lepšie")}
      ${kpi(o.brier_model_only.toFixed(3), "Brier skóre len model (bez analytika)")}</div>`;
    const rows = Object.entries(t.by_competition).filter(([, v]) => v.n).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v.n}</td><td>${pct(v.hit_1x2)}</td><td>${pct(v.hit_exact)}</td><td>${v.brier.toFixed(3)}</td></tr>`).join("");
    html += `<h2>Podľa súťaže</h2><div class="table-wrap"><table><thead><tr><th>Súťaž</th><th>Zápasy</th><th>1X2</th><th>Presné skóre</th><th>Brier</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    const rec = (t.recent || []).map((r) => `<tr><td>${esc(r.kickoff.slice(0, 10))}</td><td>${esc(r.home)} – ${esc(r.away)}</td><td>${esc(r.pred_score)}</td><td><b>${esc(r.result)}</b></td><td>${r.p.map(pct).join(" / ")}</td></tr>`).join("");
    html += `<h2>Posledné výsledky</h2><div class="table-wrap"><table><thead><tr><th>Dátum</th><th>Zápas</th><th>Tip</th><th>Výsledok</th><th>1 / X / 2</th></tr></thead><tbody>${rec}</tbody></table></div>`;
    return html + `<p class="muted">Brier skóre pod 0,667 znamená lepšie než hádanie rovnomerne; porovnaj s trhom, ak sú k dispozícii kurzy.</p>`;
  }

  function render() {
    const tab = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "interesting";
    document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
    const warns = (state.meta.warnings || []).length ? `<div class="warn-box"><b>Upozornenia z posledného behu:</b><ul class="plain">${state.meta.warnings.slice(0, 8).map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div>` : "";
    const body = { interesting: renderInteresting, weekend: renderWeekend, nations_league: renderNations, track: renderTrack }[tab]();
    const plan = state.meta.api && state.meta.api.plan_blocked
      ? `<div class="warn-box"><b>API-Football: tvoj plán nemá prístup k aktuálnej sezóne.</b> Bez nej nie sú rozpisy ani výsledky, takže predikcie budú neúplné alebo žiadne. Treba vyšší plán na <a href="https://dashboard.api-football.com" target="_blank" rel="noopener noreferrer">dashboard.api-football.com</a>.</div>` : "";
    const src = state.meta.sources ? `<details class="sources"><summary>Zdroje dát</summary><ul class="plain">${Object.entries(state.meta.sources).map(([k, v]) => `<li>${esc(k)}: ${esc(v)}</li>`).join("")}</ul></details>` : "";
    $app.innerHTML = plan + body + (tab === "track" ? src : warns + src);
  }

  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => { location.hash = b.dataset.tab; }));
  window.addEventListener("hashchange", () => { if (state.pred) { render(); window.scrollTo({ top: 0 }); } });
  load();
  poll();
})();
