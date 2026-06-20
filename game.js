/* ============================================================
   Seshachalam Guardian — game engine
   A game-theoretic simulation of red sandalwood conservation.
   ============================================================ */
(function () {
  "use strict";

  /* ---------------- Constants / tuning ---------------- */
  const CONFIG = {
    TOTAL_ROUNDS: 10,
    START_FOREST: 100,
    TREES_PER_POACH: 3,
    PHASE1_END: 3, // rounds 1..3 are the state ban
    ESCROW_START: 4, // round 4 escrow goes live
    ESCROW_WAGE: 10, // guaranteed guard wage from escrow
    BAN_BRIBE: 20, // poach payoff under the state ban
    ESCROW_BRIBE: 20, // baseline smuggler bribe in escrow era
    CITES_START: 6,
    CITES_END: 8,
    CITES_BUFFER_START: 2, // "turns of buffer left" shown at round 6
    CITES_BRIBE: { 6: 20, 7: 40, 8: 60 }, // escalating squeeze
    PENALTY_PER_CHEATER: 4, // escrow wage cut per cheater next round
  };

  /* ---------------- Bot personalities ----------------
     Each bot returns true to POACH, false to GUARD, given a context. */
  const PERSONALITIES = {
    riskAverse: {
      key: "riskAverse",
      emoji: "🛖",
      tag: "Risk-Averse",
      blurb: "Fears the state. Guards unless starving.",
      decide(ctx, self) {
        // Terrified of penalties. Only poaches when nearly broke AND bribe is large.
        const starving = self.cash <= 5;
        const desperate = self.cash <= 0;
        const bigBribe = ctx.bribe >= 40;
        if (desperate) return Math.random() < 0.55;
        if (starving && bigBribe) return Math.random() < 0.45;
        // late-game panic if the safety net is gone
        if (ctx.escrowCollapsed && bigBribe) return Math.random() < 0.5;
        return Math.random() < 0.05;
      },
    },
    hyperbolic: {
      key: "hyperbolic",
      emoji: "🏕️",
      tag: "Hyperbolic Discounter",
      blurb: "Wants cash NOW. Loves a fat bribe.",
      decide(ctx, self) {
        // Instant gratification: probability scales hard with the bribe size.
        let p = ctx.bribe / 70; // 20→.29, 40→.57, 60→.86
        if (ctx.escrowActive && !ctx.escrowCollapsed) p -= 0.18; // a wage tempers them a little
        if (ctx.escrowCollapsed) p += 0.2;
        if (self.cash <= 0) p += 0.15;
        return Math.random() < clamp(p, 0.05, 0.95);
      },
    },
    opportunistic: {
      key: "opportunistic",
      emoji: "🏚️",
      tag: "Opportunistic",
      blurb: "Cold calculator. Cheats when risk is low.",
      decide(ctx, self) {
        // Calculates risk vs reward. Exploits blind spots: low enforcement = poach.
        // In escrow era, "risk" = chance of being flagged & punished collectively.
        let p;
        if (!ctx.escrowActive) {
          p = 0.55; // ban era is barely enforced -> cheat often
        } else if (ctx.escrowCollapsed) {
          p = 0.8; // no safety net, no future payout to protect -> grab cash
        } else {
          // protects the escrow wage while it lasts, but probes for advantage
          p = 0.2 + (ctx.bribe - 20) / 120; // rises as bribe climbs
        }
        if (ctx.lastRoundCheaters > 0 && ctx.escrowActive) p += 0.1; // "others cheat, why shouldn't I"
        return Math.random() < clamp(p, 0.05, 0.95);
      },
    },
    conditional: {
      key: "conditional",
      emoji: "⛺",
      tag: "Conditional Co-operator",
      blurb: "Mirrors the village. Cheats if others did.",
      decide(ctx, self) {
        // Tit-for-tat-ish: cooperates by default, retaliates against last round's cheating.
        if (!ctx.escrowActive) {
          // under the ban there is no reciprocity mechanism -> follows the herd
          return ctx.lastRoundCheaters >= 2 ? Math.random() < 0.6 : Math.random() < 0.25;
        }
        if (ctx.escrowCollapsed && ctx.bribe >= 60) return Math.random() < 0.55;
        if (ctx.lastRoundCheaters >= 2) return Math.random() < 0.5;
        if (ctx.lastRoundCheaters === 1) return Math.random() < 0.2;
        return Math.random() < 0.05;
      },
    },
  };

  /* ---------------- Game state ---------------- */
  let S = null;

  function freshState() {
    const botKeys = ["riskAverse", "hyperbolic", "opportunistic", "conditional"];
    const villages = [
      { id: 1, name: "Your Village", emoji: "🏡", tag: "You", isPlayer: true, cash: 0, lastAction: null },
    ];
    botKeys.forEach((k, i) => {
      villages.push({
        id: i + 2,
        name: "Village " + (i + 2),
        emoji: PERSONALITIES[k].emoji,
        tag: PERSONALITIES[k].tag,
        blurb: PERSONALITIES[k].blurb,
        isPlayer: false,
        personality: k,
        cash: 0,
        lastAction: null,
      });
    });
    return {
      round: 1,
      forest: CONFIG.START_FOREST,
      villages,
      lastRoundCheaters: 0, // cheaters in the PREVIOUS round (drives escrow penalty)
      citesBuffer: CONFIG.CITES_BUFFER_START,
      escrowCollapsed: false, // true once buffer is exhausted (round 8 onward in freeze)
      playerChoice: null,
      gameOver: false,
      history: [],
    };
  }

  /* ---------------- Round context (phase logic) ---------------- */
  function roundContext(s) {
    const r = s.round;
    const escrowActive = r >= CONFIG.ESCROW_START;
    const inCites = r >= CONFIG.CITES_START && r <= CONFIG.CITES_END;

    let bribe;
    if (!escrowActive) bribe = CONFIG.BAN_BRIBE;
    else if (inCites) bribe = CONFIG.CITES_BRIBE[r];
    else bribe = CONFIG.ESCROW_BRIBE;

    // Escrow wage available this round: slashed by last round's cheaters, zeroed if collapsed.
    let wage = 0;
    if (escrowActive) {
      if (s.escrowCollapsed) {
        wage = 0;
      } else {
        wage = Math.max(0, CONFIG.ESCROW_WAGE - s.lastRoundCheaters * CONFIG.PENALTY_PER_CHEATER);
      }
    }

    return {
      round: r,
      escrowActive,
      inCites,
      bribe,
      wage,
      escrowCollapsed: s.escrowCollapsed,
      lastRoundCheaters: s.lastRoundCheaters,
      phase: !escrowActive ? "ban" : inCites ? "cites" : "escrow",
    };
  }

  /* ---------------- DOM helpers ---------------- */
  const $ = (id) => document.getElementById(id);
  function show(screenId) {
    document.querySelectorAll(".screen").forEach((el) => el.classList.remove("active"));
    $(screenId).classList.add("active");
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  /* ---------------- Forest canvas rendering ---------------- */
  const canvas = $("forest-canvas");
  const ctx2d = canvas.getContext("2d");
  // deterministic tree positions so the forest looks stable as it thins
  const TREE_SLOTS = (function () {
    const slots = [];
    const cols = 14, rows = 8;
    let seed = 1337;
    const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const jx = (rnd() - 0.5) * 22;
        const jy = (rnd() - 0.5) * 14;
        const x = 24 + (col + 0.5) * ((520 - 48) / cols) + jx;
        const y = 60 + (row + 0.5) * ((300 - 80) / rows) + jy;
        const scale = 0.7 + (row / rows) * 0.7 + rnd() * 0.2;
        slots.push({ x, y, scale, depth: row });
      }
    }
    // sort back-to-front for proper overlap
    return slots.sort((a, b) => a.depth - b.depth);
  })();

  function drawTree(x, y, scale, alive) {
    const c = ctx2d;
    const h = 34 * scale;
    const w = 16 * scale;
    if (alive) {
      // trunk
      c.fillStyle = "#5b3a22";
      c.fillRect(x - 2 * scale, y, 4 * scale, 10 * scale);
      // sandalwood canopy (deep red-green hint)
      const grad = c.createLinearGradient(x, y - h, x, y);
      grad.addColorStop(0, "#3fae73");
      grad.addColorStop(1, "#1c6b43");
      c.fillStyle = grad;
      c.beginPath();
      c.moveTo(x, y - h);
      c.lineTo(x - w, y);
      c.lineTo(x + w, y);
      c.closePath();
      c.fill();
      c.beginPath();
      c.moveTo(x, y - h * 1.25);
      c.lineTo(x - w * 0.8, y - h * 0.45);
      c.lineTo(x + w * 0.8, y - h * 0.45);
      c.closePath();
      c.fill();
    } else {
      // stump
      c.fillStyle = "rgba(120,70,45,0.55)";
      c.fillRect(x - 3 * scale, y - 2, 6 * scale, 8 * scale);
      c.fillStyle = "rgba(80,45,30,0.5)";
      c.fillRect(x - 5 * scale, y + 5 * scale, 10 * scale, 2);
    }
  }

  function renderForest() {
    const c = ctx2d;
    c.clearRect(0, 0, canvas.width, canvas.height);
    // ground
    const g = c.createLinearGradient(0, 0, 0, 300);
    g.addColorStop(0, "#13301f");
    g.addColorStop(1, "#0a160f");
    c.fillStyle = g;
    c.fillRect(0, 0, 520, 300);
    // mist
    c.fillStyle = "rgba(120,200,150,0.05)";
    c.fillRect(0, 40, 520, 60);

    const aliveCount = Math.round((S.forest / CONFIG.START_FOREST) * TREE_SLOTS.length);
    TREE_SLOTS.forEach((slot, i) => {
      drawTree(slot.x, slot.y, slot.scale, i < aliveCount);
    });

    // overlay text if collapsed
    if (S.forest <= 0) {
      c.fillStyle = "rgba(140,47,40,0.35)";
      c.fillRect(0, 0, 520, 300);
      c.fillStyle = "#ff8a80";
      c.font = "bold 26px Cinzel, serif";
      c.textAlign = "center";
      c.fillText("ECOLOGICAL COLLAPSE", 260, 155);
    }
  }

  /* ---------------- HUD + villages rendering ---------------- */
  function renderHUD() {
    const player = S.villages[0];
    $("hud-round").textContent = S.round + " / " + CONFIG.TOTAL_ROUNDS;
    $("hud-cash").textContent = player.cash;
    $("hud-forest").textContent = Math.max(0, S.forest);

    const pct = clamp((S.forest / CONFIG.START_FOREST) * 100, 0, 100);
    const fill = $("forest-meter-fill");
    fill.style.width = pct + "%";
    if (pct <= 20) fill.style.background = "linear-gradient(90deg,#8c2f28,#ef5350)";
    else if (pct <= 45) fill.style.background = "linear-gradient(90deg,#9a6a1e,#e7b85c)";
    else fill.style.background = "linear-gradient(90deg,#1f7a4d,#4fd18b)";

    $("forest-badge").textContent = Math.max(0, S.forest) + " trees standing";

    const ctxR = roundContext(S);
    // phase banner
    const banner = $("phase-banner");
    const txt = $("phase-banner-text");
    banner.classList.remove("escrow", "crisis");
    if (ctxR.phase === "ban") {
      txt.innerHTML = "Phase 1 · Command &amp; Control State Ban";
    } else if (ctxR.phase === "cites") {
      banner.classList.add("crisis");
      txt.innerHTML = "🚨 CITES EXPORT FREEZE · Round " + S.round + " · The Squeeze Is On";
    } else {
      banner.classList.add("escrow");
      txt.innerHTML = "Phase 2 · Pre-Funded International Escrow";
    }

    // escrow badge
    const eb = $("escrow-badge");
    if (!ctxR.escrowActive) eb.textContent = "Escrow: dormant";
    else if (ctxR.escrowCollapsed) eb.textContent = "Escrow: DEPLETED (wage 0)";
    else eb.textContent = "Escrow wage: +" + ctxR.wage + " cash";

    // CITES alert
    const alert = $("cites-alert");
    if (ctxR.inCites) {
      alert.hidden = false;
      $("cites-buffer").textContent = Math.max(0, S.citesBuffer);
      $("cites-bribe").textContent = ctxR.bribe;
    } else {
      alert.hidden = true;
    }

    // decision buttons
    $("guard-sub").textContent = ctxR.escrowActive
      ? (ctxR.wage > 0 ? "+" + ctxR.wage + " cash (escrow)" : "+0 cash (escrow depleted)")
      : "+0 cash";
    $("poach-sub").textContent = "+" + ctxR.bribe + " cash · −" + CONFIG.TREES_PER_POACH + " trees";

    // smuggler line
    const offer = $("smuggler-offer");
    if (ctxR.phase === "cites") {
      const lines = {
        6: '"The borders are closing. +20 now, before the escrow dries up."',
        7: '"No exports, no escrow refill. Double or nothing — +40 cash."',
        8: '"Last chance. The reserve is empty. +60 cash. Everyone is cracking."',
      };
      offer.textContent = lines[S.round];
    } else if (ctxR.escrowActive) {
      offer.textContent = '"A quiet +' + ctxR.bribe + ' cash. The DNA ledger? Who reads it, really?"';
    } else {
      offer.textContent = '"+' + ctxR.bribe + ' cash to look away. Three trees, gone. The guards are far."';
    }

    renderVillages(ctxR);
    renderForest();
  }

  function renderVillages(ctxR) {
    const wrap = $("villages");
    wrap.innerHTML = "";
    S.villages.forEach((v) => {
      const el = document.createElement("div");
      el.className = "village" + (v.isPlayer ? " you" : "");
      const tagLine = v.isPlayer ? "That's you" : v.tag;
      const blurb = v.isPlayer ? "Decide each round" : (v.blurb || "");

      let statusHtml = '<div class="v-status">Deciding…</div>';
      if (v.lastAction === "guard") statusHtml = '<div class="v-status guard">🛡️ Guarded last round</div>';
      else if (v.lastAction === "poach") statusHtml = '<div class="v-status poach">🪓 Poached last round</div>';

      el.innerHTML =
        '<div class="v-top">' +
          '<span class="v-emoji">' + v.emoji + '</span>' +
          '<span class="v-name">' + v.name + '</span>' +
          '<span class="v-tag">' + tagLine + '<br>' + escapeHtml(blurb) + '</span>' +
        '</div>' +
        '<div class="v-cash">Cash: <b>' + v.cash + '</b></div>' +
        statusHtml;
      wrap.appendChild(el);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  /* ---------------- Round resolution ---------------- */
  function resolveRound(playerPoached) {
    const ctxR = roundContext(S);
    const decisions = [];

    // player
    S.villages[0].lastAction = playerPoached ? "poach" : "guard";
    decisions.push({ v: S.villages[0], poach: playerPoached });

    // bots
    for (let i = 1; i < S.villages.length; i++) {
      const v = S.villages[i];
      const p = PERSONALITIES[v.personality];
      const poach = p.decide(ctxR, v);
      v.lastAction = poach ? "poach" : "guard";
      decisions.push({ v, poach });
    }

    // apply payoffs
    let cheaters = 0;
    let treesLost = 0;
    decisions.forEach((d) => {
      if (d.poach) {
        d.v.cash += ctxR.bribe;
        treesLost += CONFIG.TREES_PER_POACH;
        cheaters++;
      } else {
        d.v.cash += ctxR.wage; // 0 in ban era
      }
    });

    S.forest = Math.max(0, S.forest - treesLost);

    // CITES buffer drain: each freeze round consumes a turn of buffer.
    let bufferNote = null;
    if (ctxR.inCites) {
      S.citesBuffer -= 1;
      if (S.citesBuffer <= 0 && !S.escrowCollapsed) {
        S.escrowCollapsed = true;
        bufferNote = "The emergency escrow buffer is exhausted — the legal safety net is gone.";
      }
    }

    // set up next round's escrow penalty
    S.lastRoundCheaters = cheaters;

    const record = { round: S.round, ctxR, decisions, cheaters, treesLost, bufferNote };
    S.history.push(record);
    return record;
  }

  /* ---------------- Resolution UI ---------------- */
  function showResolution(record) {
    const { ctxR, decisions, cheaters, treesLost, bufferNote } = record;
    $("res-title").textContent = "Round " + record.round + " — Results";

    const log = $("res-log");
    log.innerHTML = "";
    decisions.forEach((d, idx) => {
      const row = document.createElement("div");
      row.className = "res-row";
      row.style.animationDelay = idx * 0.05 + "s";
      const gain = d.poach ? ctxR.bribe : ctxR.wage;
      row.innerHTML =
        '<span class="rr-name">' + d.v.emoji + " " + (d.v.isPlayer ? "You" : "V" + d.v.id) + '</span>' +
        '<span class="rr-act ' + (d.poach ? "poach" : "guard") + '">' +
          (d.poach ? "🪓 Poached" : "🛡️ Guarded") + '</span>' +
        '<span class="rr-delta">+' + gain + ' cash</span>';
      log.appendChild(row);
    });

    const summary = $("res-summary");
    let html = "";
    html += treesLost > 0
      ? '<span class="neg">' + cheaters + " village" + (cheaters > 1 ? "s" : "") +
        " poached — " + treesLost + " trees felled.</span> "
      : '<span class="pos">The whole village held the line. No trees lost.</span> ';

    if (ctxR.escrowActive && !ctxR.escrowCollapsed) {
      if (cheaters > 0) {
        const cut = cheaters * CONFIG.PENALTY_PER_CHEATER;
        html += "The DNA ledger flagged the illicit timber. <strong>Next round's escrow wage is cut by " +
          cut + " (to " + Math.max(0, CONFIG.ESCROW_WAGE - cut) + ").</strong> ";
      } else {
        html += "Clean ledger — full escrow wage restored next round. ";
      }
    }
    if (bufferNote) html += '<br><span class="neg">⚠️ ' + bufferNote + "</span>";
    if (S.forest <= 0) html += '<br><span class="neg">The forest is gone.</span>';

    summary.innerHTML = html;

    // event log line
    addLogLine(record);

    const res = $("resolution");
    res.hidden = false;

    // refresh board behind overlay
    renderHUD();
  }

  function addLogLine(record) {
    const ul = $("event-log");
    const li = document.createElement("li");
    if (record.ctxR.inCites) li.classList.add("crisis");
    const playerAct = record.decisions[0].poach ? "poached" : "guarded";
    li.innerHTML =
      '<span class="lg-round">R' + record.round + "</span>" +
      "You " + playerAct + ". " + record.cheaters + "/5 villages poached, " +
      record.treesLost + " trees lost. Forest: " + Math.max(0, S.forest) + ".";
    ul.prepend(li);
  }

  /* ---------------- Flow control ---------------- */
  function startGame() {
    S = freshState();
    $("event-log").innerHTML = "";
    show("screen-game");
    renderHUD();
    setDecisionEnabled(true);
  }

  function setDecisionEnabled(on) {
    $("btn-guard").disabled = !on;
    $("btn-poach").disabled = !on;
  }

  function onChoice(poach) {
    if (S.gameOver) return;
    setDecisionEnabled(false);
    const record = resolveRound(poach);
    showResolution(record);
  }

  function nextRound() {
    $("resolution").hidden = true;

    if (S.forest <= 0) return endGame(false, "collapse");
    if (S.round >= CONFIG.TOTAL_ROUNDS) return endGame(true, "survived");

    S.round += 1;
    renderHUD();
    setDecisionEnabled(true);
  }

  /* ---------------- End game + scoring ---------------- */
  function endGame(survived, reason) {
    S.gameOver = true;
    const player = S.villages[0];
    const forest = Math.max(0, S.forest);
    // Score rewards BOTH personal cash and standing forest (the cooperative ideal).
    const score = Math.round(player.cash * 1 + forest * 6);

    const card = $("over-card");
    card.classList.remove("win", "lose");

    let title, text, emblem;
    if (!survived) {
      card.classList.add("lose");
      emblem = "🪵";
      title = "Ecological Collapse";
      text = "The last red sandalwood fell. The smuggler moves on; the hills fall silent. " +
        "Short-term cash could not buy back a dead forest — the tragedy of the commons, complete.";
    } else if (forest >= 70) {
      card.classList.add("win");
      emblem = "🌳🛡️";
      title = "Guardian of the Hills";
      text = "You held the commons together through the CITES squeeze. The escrow and peer enforcement " +
        "held where the state ban failed. This is Ostrom's lesson made real.";
    } else if (forest >= 35) {
      card.classList.add("win");
      emblem = "🌲";
      title = "The Forest Endures";
      text = "Battered but standing. The community bent under the 60-cash squeeze yet avoided total collapse. " +
        "A fragile, hard-won cooperation.";
    } else {
      card.classList.add("lose");
      emblem = "🍂";
      title = "A Hollow Survival";
      text = "The forest technically survived the ten rounds, but barely. Another season of this and the " +
        "commons would be gone. Cooperation frayed when the safety net disappeared.";
    }

    $("over-emblem").textContent = emblem;
    $("over-title").textContent = title;
    $("over-text").textContent = text;

    const cheatRounds = S.history.filter((h) => h.decisions[0].poach).length;
    $("over-stats").innerHTML =
      statBox(player.cash, "Your Cash") +
      statBox(forest, "Trees Saved") +
      statBox(score, "Final Score") +
      statBox(cheatRounds + " / " + S.history.length, "Rounds You Poached") +
      statBox(richestVillage(), "Richest Village") +
      statBox(S.history.reduce((a, h) => a + h.treesLost, 0), "Total Trees Felled");

    show("screen-over");
  }

  function statBox(val, lbl) {
    return '<div class="over-stat"><div class="os-val">' + val + '</div><div class="os-lbl">' + lbl + "</div></div>";
  }
  function richestVillage() {
    let best = S.villages[0];
    S.villages.forEach((v) => { if (v.cash > best.cash) best = v; });
    return best.isPlayer ? "You" : "V" + best.id;
  }

  /* ---------------- Wiring ---------------- */
  function init() {
    $("btn-start").addEventListener("click", startGame);
    $("btn-playagain").addEventListener("click", startGame);
    $("btn-restart").addEventListener("click", () => {
      if (confirm("Restart the game? Progress will be lost.")) startGame();
    });
    $("btn-guard").addEventListener("click", () => onChoice(false));
    $("btn-poach").addEventListener("click", () => onChoice(true));
    $("btn-next").addEventListener("click", nextRound);

    $("btn-how").addEventListener("click", () => $("modal-how").classList.add("open"));
    document.querySelectorAll("[data-close-modal]").forEach((b) =>
      b.addEventListener("click", () => $("modal-how").classList.remove("open"))
    );
    $("modal-how").addEventListener("click", (e) => {
      if (e.target === $("modal-how")) $("modal-how").classList.remove("open");
    });

    // keyboard shortcuts
    document.addEventListener("keydown", (e) => {
      if ($("screen-game").classList.contains("active") && !$("resolution").hidden === false) {
        // resolution open -> Enter advances
      }
      if ($("screen-game").classList.contains("active")) {
        if (!$("resolution").hidden && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault(); nextRound();
        } else if ($("resolution").hidden) {
          if (e.key.toLowerCase() === "g") onChoice(false);
          if (e.key.toLowerCase() === "p") onChoice(true);
        }
      }
    });

    show("screen-intro");
  }

  document.addEventListener("DOMContentLoaded", init);
})();
