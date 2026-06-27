/* ============================================================
   Seshachalam Guardian — Online Multiplayer (Option B)
   2 human villages + 1 human smuggler, across cities, via Firebase.
   Host-authoritative: only the room creator computes resolutions.
   ============================================================ */
(function () {
  "use strict";

  /* ---------------- config / tuning ---------------- */
  const CFG = {
    ROUNDS: 10, START: 100, TREES: 3,
    ESCROW_START: 4, CITES_START: 6, CITES_END: 8, BUFFER: 2,
    WAGE: 10, PENALTY: 4,
    DETECT_BASE: 0.8, DETECT_CORRUPT: 0.4, CORRUPT_COST: 15,
    TIMBER_BASE: 5, TIMBER_MAX: 60, TIP: 25, REGROW: 2,
    WARCHEST: 120, SMUGGLER_WIN: 160, BRIBE_MAX: 80, TARGET_BOOST: 1.5,
  };
  const VIDS = [1, 2, 3, 4, 5];
  const BOT_PERSONA = { 1: "riskAverse", 2: "conditional", 3: "opportunistic", 4: "hyperbolic", 5: "conditional" };

  // bot poach-probabilities (mirror single-player)
  const PROB = {
    riskAverse: (c, s) => { const big = c.bribe >= 40; if (s.cash <= 0) return 0.55; if (s.cash <= 5 && big) return 0.45; if (c.escrowCollapsed && big) return 0.5; return 0.05; },
    hyperbolic: (c, s) => { let p = c.bribe / 70; if (c.escrowActive && !c.escrowCollapsed) p -= 0.18; if (c.escrowCollapsed) p += 0.2; if (s.cash <= 0) p += 0.15; return p; },
    opportunistic: (c, s) => { let p; if (!c.escrowActive) p = 0.55; else if (c.escrowCollapsed) p = 0.8; else p = 0.2 + (c.bribe - 20) / 120; if (c.lastRoundCheaters > 0 && c.escrowActive) p += 0.1; return p; },
    conditional: (c, s) => { if (!c.escrowActive) return c.lastRoundCheaters >= 2 ? 0.6 : 0.25; if (c.escrowCollapsed && c.bribe >= 60) return 0.55; if (c.lastRoundCheaters >= 2) return 0.5; if (c.lastRoundCheaters === 1) return 0.2; return 0.05; },
  };

  /* ---------------- helpers ---------------- */
  const $ = (id) => document.getElementById(id);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  function show(id) { document.querySelectorAll(".screen").forEach((e) => e.classList.remove("active")); const el = $(id); if (el) el.classList.add("active"); }
  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
  function vkey(id) { return "v" + id; }

  /* ---------------- firebase ---------------- */
  let db = null, app = null;
  function fbReady() {
    const cfg = window.FIREBASE_CONFIG;
    if (!cfg || !cfg.apiKey || cfg.apiKey === "PASTE_HERE") return false;
    if (typeof firebase === "undefined") return false;
    if (!app) {
      try { app = firebase.initializeApp(cfg); db = firebase.database(); }
      catch (e) { console.error(e); return false; }
    }
    return true;
  }

  /* ---------------- session ---------------- */
  let me = { id: null, name: "Player", role: null, code: null, isHost: false };
  let roomRef = null, roomListener = null, room = null;
  let resolving = false, lastActionKey = "";

  function myPid() {
    try {
      let id = localStorage.getItem("sg_pid");
      if (!id) { id = "p" + Math.random().toString(36).slice(2, 9); localStorage.setItem("sg_pid", id); }
      return id;
    } catch (e) { return "p" + Math.random().toString(36).slice(2, 9); }
  }
  function randCode() { const A = "ABCDEFGHJKLMNPQRSTUVWXYZ"; let s = ""; for (let i = 0; i < 4; i++) s += A[(Math.random() * A.length) | 0]; return s; }

  /* ---------------- room model helpers ---------------- */
  function players(r) { return (r && r.players) || {}; }
  function connectedWithRole(r, role) {
    const ps = players(r);
    return Object.keys(ps).filter((id) => ps[id] && ps[id].connected !== false && ps[id].role === role);
  }
  function roleTakenBy(r, role) { const arr = connectedWithRole(r, role); return arr[0] || null; }
  function smugglerIsHuman(r) { return connectedWithRole(r, "smuggler").length > 0; }
  function humanVillageIds(r) {
    const ids = [];
    if (connectedWithRole(r, "villageA").length) ids.push(1);
    if (connectedWithRole(r, "villageB").length) ids.push(2);
    return ids;
  }
  function isHumanVillage(r, id) { return humanVillageIds(r).indexOf(id) !== -1; }
  function myVillageId() { return me.role === "villageA" ? 1 : me.role === "villageB" ? 2 : null; }

  /* ---------------- game context ---------------- */
  function ctxFor(round, st) {
    const escrowActive = round >= CFG.ESCROW_START;
    const inCites = round >= CFG.CITES_START && round <= CFG.CITES_END;
    const collapsed = !!(st && st.escrowCollapsed);
    let wage = 0;
    if (escrowActive) wage = collapsed ? 0 : Math.max(0, CFG.WAGE - ((st && st.lastCaught) || 0) * CFG.PENALTY);
    const defaultBribe = !escrowActive ? 20 : inCites ? ({ 6: 20, 7: 40, 8: 60 }[round]) : 20;
    const phase = !escrowActive ? "ban" : inCites ? "cites" : "escrow";
    return { round, escrowActive, inCites, collapsed, wage, defaultBribe, phase, escrowCollapsed: collapsed, lastRoundCheaters: (st && st.lastCaught) || 0 };
  }
  function timberPrice(forest) { return clamp(Math.round(CFG.TIMBER_BASE * 100 / Math.max(forest, 1)), CFG.TIMBER_BASE, CFG.TIMBER_MAX); }

  /* ============================================================
     LOBBY
     ============================================================ */
  function openLobby() {
    show("screen-mp-lobby");
    $("mp-room").hidden = true;
    $("mp-entry").hidden = false;
    if (!fbReady()) {
      $("mp-status").innerHTML = "⚠️ Online play isn't configured yet. Add your Firebase keys to <code>firebase-config.js</code> (see the comments in that file).";
      $("mp-status").classList.add("warn");
      $("mp-create").disabled = true; $("mp-join").disabled = true;
      return;
    }
    $("mp-status").textContent = "Ready. Create a room, or join with a code.";
    $("mp-status").classList.remove("warn");
    $("mp-create").disabled = false; $("mp-join").disabled = false;
  }

  function attachRoom(code) {
    detachRoom();
    me.code = code;
    roomRef = db.ref("rooms/" + code);
    roomListener = roomRef.on("value", (snap) => {
      room = snap.val();
      if (!room) { return; }
      onRoomUpdate(room);
    });
    // presence
    const meRef = roomRef.child("players/" + me.id);
    meRef.update({ name: me.name, connected: true, role: me.role || null });
    meRef.child("connected").onDisconnect().set(false);
  }
  function detachRoom() {
    if (roomRef && roomListener) roomRef.off("value", roomListener);
    roomListener = null; resolving = false; lastActionKey = "";
  }

  function createRoom() {
    if (!fbReady()) return;
    me.name = ($("mp-name").value || "Host").trim().slice(0, 14);
    me.isHost = true; me.role = null;
    const code = randCode();
    const meta = { phase: "lobby", hostId: me.id, round: 1, subphase: "smuggler", createdAt: Date.now() };
    db.ref("rooms/" + code).set({ meta, players: { [me.id]: { name: me.name, connected: true, role: null, host: true } } })
      .then(() => attachRoom(code));
  }
  function joinRoom() {
    if (!fbReady()) return;
    const code = ($("mp-code").value || "").toUpperCase().trim();
    if (code.length !== 4) { $("mp-status").textContent = "Enter the 4-letter room code."; return; }
    me.name = ($("mp-name").value || "Player").trim().slice(0, 14);
    me.isHost = false; me.role = null;
    db.ref("rooms/" + code).child("meta").get().then((snap) => {
      if (!snap.exists()) { $("mp-status").textContent = "No room with code " + code + "."; return; }
      attachRoom(code);
    });
  }

  function claimRole(role) {
    if (!room) return;
    const taker = roleTakenBy(room, role);
    if (taker && taker !== me.id) { flashStatus("That role is taken — pick another."); return; }
    me.role = role;
    roomRef.child("players/" + me.id).update({ role, name: me.name, connected: true });
  }

  function startGame() {
    if (!me.isHost || !room) return;
    if (!smugglerIsHuman(room) && humanVillageIds(room).length === 0) return;
    const st = {
      forest: CFG.START, buffer: CFG.BUFFER, escrowCollapsed: false, lastCaught: 0,
      warChest: CFG.WARCHEST, profit: 0,
      villages: {},
    };
    VIDS.forEach((id) => (st.villages[vkey(id)] = { cash: 0 }));
    roomRef.update({ "meta/phase": "playing", "meta/round": 1, "meta/subphase": "smuggler", "state": st });
  }

  /* ============================================================
     ROOM UPDATE DISPATCH
     ============================================================ */
  function onRoomUpdate(r) {
    const phase = r.meta && r.meta.phase;
    // keep my role in sync if server has it
    const meP = players(r)[me.id];
    if (meP && meP.role) me.role = meP.role;
    if (meP && meP.host) me.isHost = true;

    if (phase === "lobby") { renderLobby(r); }
    else if (phase === "playing") { renderGame(r); if (me.isHost) hostTick(r); }
    else if (phase === "over") { renderOver(r); }
  }

  function renderLobby(r) {
    show("screen-mp-lobby");
    $("mp-entry").hidden = true;
    $("mp-room").hidden = false;
    $("mp-roomcode-val").textContent = me.code;
    // role claims
    ["smuggler", "villageA", "villageB"].forEach((role) => {
      const who = document.querySelector('.mp-role-who[data-who="' + role + '"]');
      const taker = roleTakenBy(r, role);
      const card = document.querySelector('.mp-role[data-role="' + role + '"]');
      if (taker) {
        who.textContent = (taker === me.id ? "You" : (players(r)[taker] && players(r)[taker].name) || "Player");
        who.classList.add("claimed");
        card.classList.toggle("mine", taker === me.id);
        card.classList.toggle("taken", taker !== me.id);
      } else {
        who.textContent = "open"; who.classList.remove("claimed");
        card.classList.remove("mine", "taken");
      }
    });
    // start button (host only)
    const startBtn = $("mp-start");
    const hint = $("mp-start-hint");
    if (me.isHost) {
      startBtn.style.display = "";
      const smug = smugglerIsHuman(r), vills = humanVillageIds(r).length;
      const ok = smug && vills >= 1;
      startBtn.disabled = !ok;
      hint.textContent = ok
        ? (vills < 2 ? "Tip: unclaimed villages will be played by AI." : "All set — start when ready.")
        : "Need at least the Smuggler + 1 Village claimed.";
    } else {
      startBtn.style.display = "none";
      hint.textContent = "Waiting for the host to start…";
    }
  }

  /* ============================================================
     HOST STATE MACHINE
     ============================================================ */
  function hostTick(r) {
    if (!me.isHost || !r.meta || r.meta.phase !== "playing") return;
    const round = r.meta.round, sub = r.meta.subphase;
    const turns = (r.turns && r.turns[round]) || {};

    if (sub === "smuggler") {
      if (!turns.smuggler) {
        if (!smugglerIsHuman(r)) {
          const ctx = ctxFor(round, r.state);
          roomRef.child("turns/" + round + "/smuggler").set({ bribe: ctx.defaultBribe, target: 0, corrupt: false, auto: true });
        }
        return; // wait for the offer
      }
      roomRef.child("meta/subphase").set("villages");
    } else if (sub === "villages") {
      const need = humanVillageIds(r);
      const got = turns.villages || {};
      const allIn = need.every((id) => got[vkey(id)] && typeof got[vkey(id)].poach === "boolean");
      if (allIn && !(r.results && r.results[round]) && !resolving) {
        resolving = true;
        resolveRound(r, round, turns);
      }
    }
  }

  function resolveRound(r, round, turns) {
    const st = JSON.parse(JSON.stringify(r.state));
    const ctx = ctxFor(round, st);
    const s = turns.smuggler || { bribe: ctx.defaultBribe, target: 0, corrupt: false };
    const bribe = clamp(s.bribe || 0, 0, CFG.BRIBE_MAX);
    const corrupt = !!s.corrupt;
    const target = s.target || 0;
    const detect = ctx.escrowActive ? (corrupt ? CFG.DETECT_CORRUPT : CFG.DETECT_BASE) : 0;
    const timber = timberPrice(st.forest);

    const decisions = [];
    let treesLost = 0, caught = 0, poachers = 0, bribesPaid = 0;
    VIDS.forEach((id) => {
      const human = isHumanVillage(r, id);
      const effBribe = target === id ? Math.round(bribe * CFG.TARGET_BOOST) : bribe;
      let poach;
      if (human) {
        const sub = turns.villages && turns.villages[vkey(id)];
        poach = !!(sub && sub.poach);
      } else {
        const p = clamp(PROB[BOT_PERSONA[id]]({ escrowActive: ctx.escrowActive, escrowCollapsed: ctx.collapsed, bribe: effBribe, lastRoundCheaters: ctx.lastRoundCheaters }, { cash: st.villages[vkey(id)].cash }), 0.02, 0.97);
        poach = Math.random() < p;
      }
      let gain, cgt = false;
      if (poach) {
        gain = effBribe; treesLost += CFG.TREES; poachers++; bribesPaid += effBribe;
        if (detect > 0 && Math.random() < detect) { cgt = true; caught++; }
      } else { gain = ctx.wage; }
      st.villages[vkey(id)].cash += gain;
      decisions.push({ id: id, human: human, poach: poach, caught: cgt, gain: gain, targeted: target === id && bribe > 0 });
    });

    let forestAfter = Math.max(0, st.forest - treesLost);
    const sales = timber * CFG.TREES * poachers;
    const corruptCost = corrupt ? CFG.CORRUPT_COST : 0;
    st.warChest = Math.max(0, st.warChest - bribesPaid - corruptCost + sales);
    st.profit = (st.profit || 0) + sales;

    let bufferNote = null;
    if (ctx.inCites) {
      st.buffer = (st.buffer || 0) - 1;
      if (st.buffer <= 0 && !st.escrowCollapsed) { st.escrowCollapsed = true; bufferNote = "The escrow buffer is exhausted — the legal wage is gone."; }
    }
    let regrew = 0;
    if (ctx.escrowActive && !ctx.inCites && poachers === 0 && forestAfter < CFG.START && forestAfter >= CFG.TIP) {
      regrew = Math.min(CFG.REGROW, CFG.START - forestAfter); forestAfter += regrew;
    }
    st.forest = forestAfter;
    st.lastCaught = caught;

    const results = { decisions, bribe, target, corrupt, detect, timber, treesLost, caught, poachers, regrew, bufferNote, sales };
    const ended = forestAfter <= 0 || round >= CFG.ROUNDS;
    const updates = {};
    updates["state"] = st;
    updates["results/" + round] = results;
    updates["meta/subphase"] = ended ? "ended" : "reveal";
    roomRef.update(updates).then(() => { resolving = false; });
  }

  function hostNext() {
    if (!me.isHost || !room) return;
    const round = room.meta.round;
    const ended = (room.state.forest <= 0) || (round >= CFG.ROUNDS);
    if (ended) { roomRef.child("meta/phase").set("over"); return; }
    roomRef.update({ "meta/round": round + 1, "meta/subphase": "smuggler" });
  }

  /* ============================================================
     GAME RENDER (all clients)
     ============================================================ */
  function renderGame(r) {
    show("screen-mp-game");
    const round = r.meta.round, sub = r.meta.subphase, st = r.state;
    const ctx = ctxFor(round, st);
    const results = (r.results && r.results[round]) || null;

    $("mp-round").textContent = round + " / " + CFG.ROUNDS;
    $("mp-youare").textContent = me.role === "smuggler" ? "🕴️ Smuggler" : me.role === "villageA" ? "🏡 Village 1" : me.role === "villageB" ? "🏘️ Village 2" : "Spectator";
    $("mp-forest").textContent = Math.max(0, st.forest);
    $("mp-forest-badge").textContent = Math.max(0, st.forest) + " trees";
    const pct = clamp(st.forest, 0, 100);
    const fill = $("mp-forest-fill");
    fill.style.width = pct + "%";
    fill.style.background = pct <= 20 ? "linear-gradient(90deg,#8c2f28,#ef5350)" : pct <= 45 ? "linear-gradient(90deg,#9a6a1e,#e7b85c)" : "linear-gradient(90deg,#1f7a4d,#4fd18b)";

    // banner
    const banner = $("mp-phase-banner"), txt = $("mp-phase-text");
    banner.classList.remove("escrow", "crisis");
    if (ctx.phase === "ban") txt.textContent = "Phase 1 · State Ban";
    else if (ctx.phase === "cites") { banner.classList.add("crisis"); txt.textContent = "🚨 CITES Freeze · Round " + round; }
    else { banner.classList.add("escrow"); txt.textContent = "Phase 2 · Pre-Funded Escrow"; }

    // econ panel
    $("mp-wage").textContent = ctx.escrowActive ? (ctx.collapsed ? "0 (depleted)" : "+" + ctx.wage) : "— (ban)";
    $("mp-detect").textContent = ctx.escrowActive ? Math.round(CFG.DETECT_BASE * 100) + "%" : "none";
    $("mp-timber").textContent = timberPrice(st.forest);

    // cites
    if (ctx.inCites) { $("mp-cites").hidden = false; $("mp-buffer").textContent = Math.max(0, st.buffer); $("mp-bribe-shown").textContent = results ? results.bribe : "?"; }
    else $("mp-cites").hidden = true;

    // smuggler stat (visible to all — shows the threat building)
    $("mp-warchest").textContent = st.warChest;
    $("mp-profit").textContent = st.profit || 0;

    renderVillages(r, sub, results);
    renderTurnBadge(r, sub);
    renderAction(r, round, sub, ctx, results);
  }

  function renderVillages(r, sub, results) {
    const wrap = $("mp-villages");
    wrap.innerHTML = "";
    const myV = myVillageId();
    VIDS.forEach((id) => {
      const el = document.createElement("div");
      el.className = "village" + (id === myV ? " you" : "");
      const human = isHumanVillage(r, id);
      let who = human ? (id === myV ? "You" : (playerNameForVillage(r, id) || "Human")) : "AI " + capital(BOT_PERSONA[id]);
      let status = '<div class="v-status">…</div>';
      if (sub === "reveal" || sub === "ended") {
        const d = results && results.decisions && results.decisions.filter((x) => x.id === id)[0];
        if (d) {
          if (d.poach) status = '<div class="v-status poach">🪓 Poached' + (d.caught ? " · ⚠️ caught" : "") + "</div>";
          else status = '<div class="v-status guard">🛡️ Guarded</div>';
        }
      } else if (sub === "villages") {
        const got = r.turns && r.turns[r.meta.round] && r.turns[r.meta.round].villages && r.turns[r.meta.round].villages[vkey(id)];
        status = human
          ? '<div class="v-status">' + (got ? "✓ decided" : "deciding…") + "</div>"
          : '<div class="v-status">deciding…</div>';
      } else {
        status = '<div class="v-status">awaiting offer</div>';
      }
      el.innerHTML =
        '<div class="v-top"><span class="v-emoji">' + (id === 1 ? "🏡" : id === 2 ? "🏘️" : "🛖") + '</span>' +
        '<span class="v-name">Village ' + id + '</span><span class="v-tag">' + esc(who) + "</span></div>" +
        '<div class="v-cash">Cash: <b>' + (r.state.villages[vkey(id)].cash) + "</b></div>" + status;
      wrap.appendChild(el);
    });
  }
  function playerNameForVillage(r, id) {
    const role = id === 1 ? "villageA" : id === 2 ? "villageB" : null;
    if (!role) return null;
    const pid = roleTakenBy(r, role);
    return pid && players(r)[pid] ? players(r)[pid].name : null;
  }
  function capital(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

  function renderTurnBadge(r, sub) {
    const b = $("mp-turn-badge");
    if (sub === "smuggler") b.textContent = "Smuggler's move";
    else if (sub === "villages") b.textContent = "Villages decide";
    else if (sub === "reveal" || sub === "ended") b.textContent = "Round results";
    else b.textContent = "—";
  }

  /* ---------- action zone (role + subphase) ---------- */
  function renderAction(r, round, sub, ctx, results) {
    const turns = (r.turns && r.turns[round]) || {};
    const myV = myVillageId();
    const submittedSmug = !!turns.smuggler;
    const submittedVill = myV && turns.villages && turns.villages[vkey(myV)];
    // only rebuild when the meaningful state changes (preserve smuggler slider input)
    const key = [round, sub, me.role, submittedSmug ? 1 : 0, submittedVill ? 1 : 0, me.isHost ? 1 : 0].join("|");
    if (key === lastActionKey && sub !== "reveal" && sub !== "ended") return;
    lastActionKey = key;
    const host = $("mp-action-inner");

    if (sub === "smuggler") {
      if (me.role === "smuggler" && !submittedSmug) {
        host.innerHTML = smugglerControlsHTML(ctx, r.state);
        wireSmugglerControls(round, ctx);
      } else {
        host.innerHTML = waitHTML("🕴️", me.role === "smuggler" ? "Offer sent. Villages are deciding…" : "The smuggler is preparing an offer…");
      }
    } else if (sub === "villages") {
      if (myV && !submittedVill) {
        host.innerHTML = villageChoiceHTML(r, round, ctx, myV);
        wireVillageChoice(round, myV);
      } else if (myV && submittedVill) {
        host.innerHTML = waitHTML("⏳", "Choice locked: " + (submittedVill.poach ? "🪓 Poach" : "🛡️ Guard") + ". Waiting for the other village…");
      } else {
        host.innerHTML = waitHTML("🕴️", "The villages are weighing your offer…");
      }
    } else if (sub === "reveal" || sub === "ended") {
      host.innerHTML = revealHTML(r, round, results, sub);
      const nb = $("mp-next-btn");
      if (nb) nb.addEventListener("click", hostNext);
    }
  }

  function waitHTML(emoji, text) {
    return '<div class="mp-wait"><span class="mp-wait-emoji">' + emoji + '</span><span>' + esc(text) + "</span></div>";
  }

  function smugglerControlsHTML(ctx, st) {
    const def = ctx.defaultBribe;
    let opts = '<option value="0">No specific target (offer to all)</option>';
    VIDS.forEach((id) => (opts += '<option value="' + id + '">Push hard on Village ' + id + " (×1.5)</option>"));
    return (
      '<div class="mp-smug-panel">' +
      '<div class="mp-smug-title">🕴️ Your move, smuggler — Round ' + ctx.round + " (" + ctx.phase.toUpperCase() + ")</div>" +
      '<div class="mp-smug-hint">Timber sells for <b>' + timberPrice(st.forest) + "</b>/tree (rises as the forest shrinks). War chest: <b>" + st.warChest + "</b>.</div>" +
      '<label class="mp-ctl">Bribe offered per village: <b id="mp-bribe-val">' + def + '</b> cash' +
      '<input type="range" id="mp-bribe-input" min="0" max="' + CFG.BRIBE_MAX + '" value="' + def + '" step="5"></label>' +
      '<label class="mp-ctl">Target: <select id="mp-target-input">' + opts + "</select></label>" +
      '<label class="mp-ctl mp-checkbox"><input type="checkbox" id="mp-corrupt-input"> Bribe the inspector — cost ' + CFG.CORRUPT_COST +
      ", cuts detection " + Math.round(CFG.DETECT_BASE * 100) + "% → " + Math.round(CFG.DETECT_CORRUPT * 100) + "% (secret)</label>" +
      '<button id="mp-smug-submit" class="btn btn-poach" style="width:100%">Send the offer →</button>' +
      "</div>"
    );
  }
  function wireSmugglerControls(round, ctx) {
    const slider = $("mp-bribe-input"), val = $("mp-bribe-val");
    if (slider) slider.addEventListener("input", () => (val.textContent = slider.value));
    const btn = $("mp-smug-submit");
    if (btn) btn.addEventListener("click", () => {
      const bribe = parseInt($("mp-bribe-input").value, 10) || 0;
      const target = parseInt($("mp-target-input").value, 10) || 0;
      const corrupt = $("mp-corrupt-input").checked;
      btn.disabled = true;
      roomRef.child("turns/" + round + "/smuggler").set({ bribe, target, corrupt });
    });
  }

  function villageChoiceHTML(r, round, ctx, myV) {
    const results = null;
    // the village sees the bribe (and if it's been singled out), the wage, and the *base* detection risk
    const turns = (r.turns && r.turns[round]) || {};
    const s = turns.smuggler || { bribe: ctx.defaultBribe, target: 0 };
    const targeted = s.target === myV;
    const eff = targeted ? Math.round((s.bribe || 0) * CFG.TARGET_BOOST) : (s.bribe || 0);
    const wage = ctx.wage;
    const risk = ctx.escrowActive ? Math.round(CFG.DETECT_BASE * 100) + "% chance the ledger flags you" : "no ledger yet (state ban)";
    return (
      '<div class="mp-village-panel">' +
      '<div class="smuggler"><div class="smuggler-face">🕴️</div><div class="smuggler-text"><strong>The offer' +
      (targeted ? " — aimed at YOU" : "") + ':</strong><span>"+' + eff + " cash to poach. " + esc(risk) + '."</span></div></div>' +
      '<div class="mp-choice-meta">Guarding pays <b>' + (ctx.escrowActive ? "+" + wage + " (escrow)" : "+0 (ban)") + "</b> · Poaching fells 3 trees</div>" +
      '<div class="choices">' +
      '<button id="mp-guard" class="btn btn-guard"><span class="choice-main">🛡️ Guard</span><span class="choice-sub">+' + (ctx.escrowActive ? wage : 0) + " cash</span></button>" +
      '<button id="mp-poach" class="btn btn-poach"><span class="choice-main">🪓 Poach</span><span class="choice-sub">+' + eff + " cash · −3 trees</span></button>" +
      "</div></div>"
    );
  }
  function wireVillageChoice(round, myV) {
    const send = (poach) => roomRef.child("turns/" + round + "/villages/" + vkey(myV)).set({ poach });
    const g = $("mp-guard"), p = $("mp-poach");
    if (g) g.addEventListener("click", () => { g.disabled = true; if (p) p.disabled = true; send(false); });
    if (p) p.addEventListener("click", () => { p.disabled = true; if (g) g.disabled = true; send(true); });
  }

  function revealHTML(r, round, results, sub) {
    if (!results) return waitHTML("⏳", "Tallying the round…");
    let rows = "";
    results.decisions.forEach((d) => {
      rows += '<div class="res-row"><span class="rr-name">V' + d.id + (d.human ? "" : " 🤖") + '</span>' +
        '<span class="rr-act ' + (d.poach ? "poach" : "guard") + '">' + (d.poach ? "🪓 Poached" : "🛡️ Guarded") +
        (d.caught ? " ⚠️" : "") + '</span><span class="rr-delta">+' + d.gain + "</span></div>";
    });
    let summary = "";
    summary += results.treesLost > 0 ? '<span class="neg">' + results.poachers + " poached → " + results.treesLost + " trees felled" + (results.caught ? ", " + results.caught + " caught by the ledger" : "") + ".</span> "
      : '<span class="pos">Everyone held the line. No trees lost.</span> ';
    if (results.corrupt) summary += '<span class="neg">The inspector was bribed — detection was secretly halved.</span> ';
    if (results.regrew) summary += '<span class="pos">🌱 Total cooperation — forest regrew +' + results.regrew + ".</span> ";
    if (results.bufferNote) summary += '<br><span class="neg">⚠️ ' + results.bufferNote + "</span>";
    summary += '<br>Smuggler banked <b>' + results.sales + "</b> in timber this round.";
    if (r.state.forest <= 0) summary += '<br><span class="neg">The forest is gone.</span>';

    const ended = sub === "ended" || r.state.forest <= 0 || round >= CFG.ROUNDS;
    let footer;
    if (me.isHost) footer = '<button id="mp-next-btn" class="btn btn-primary btn-lg" style="width:100%">' + (ended ? "See final results →" : "Next round →") + "</button>";
    else footer = waitHTML("⏳", "Waiting for the host to continue…");

    return '<div class="mp-reveal"><h3>Round ' + round + " results</h3><div class='res-log'>" + rows + "</div>" +
      "<div class='res-summary'>" + summary + "</div>" + footer + "</div>";
  }

  /* ============================================================
     OVER
     ============================================================ */
  function renderOver(r) {
    show("screen-mp-over");
    const st = r.state;
    const forest = Math.max(0, st.forest);
    const collapsed = forest <= 0;
    const smugProfit = st.profit || 0;
    const smugProfitWin = smugProfit >= CFG.SMUGGLER_WIN;

    let emblem, title, text, cls;
    if (collapsed) {
      cls = "lose"; emblem = "🪵"; title = "Ecological Collapse — Smuggler Wins";
      text = "The commons broke. The forest is gone and the smuggler walks away rich. The structure failed exactly where it was weakest.";
    } else if (forest >= 70 && !smugProfitWin) {
      cls = "win"; emblem = "🌳🛡️"; title = "The Villages Held — Guardians";
      text = "Cooperation survived the squeeze and the smuggler's temptations. Good structure made the bad actor unable to win.";
    } else if (smugProfitWin) {
      cls = "lose"; emblem = "🕴️"; title = "Smuggler's Payday";
      text = "The forest survived, but the smuggler smuggled enough to call it a win. The gaps in the system were profitable.";
    } else {
      cls = "win"; emblem = "🌲"; title = "The Forest Endures";
      text = "Battered but standing. A fragile, hard-won cooperation against an active adversary.";
    }
    const card = $("mp-over-card");
    card.classList.remove("win", "lose"); card.classList.add(cls);
    $("mp-over-emblem").textContent = emblem;
    $("mp-over-title").textContent = title;
    $("mp-over-text").textContent = text;

    let stats = box(forest, "Trees Saved") + box(smugProfit, "Smuggler's Loot");
    VIDS.forEach((id) => { if (isHumanVillage(r, id)) stats += box(st.villages[vkey(id)].cash, "V" + id + " (" + (playerNameForVillage(r, id) || "human") + ")"); });
    $("mp-over-stats").innerHTML = stats;
  }
  function box(v, l) { return '<div class="over-stat"><div class="os-val">' + v + '</div><div class="os-lbl">' + esc(l) + "</div></div>"; }

  function leaveRoom(toMenu) {
    if (roomRef && me.id) roomRef.child("players/" + me.id + "/connected").set(false);
    detachRoom();
    room = null; me.role = null; me.isHost = false; me.code = null;
    if (toMenu) show("screen-intro"); else openLobby();
  }

  function flashStatus(msg) {
    const el = $("mp-status"); if (!el) return;
    const prev = el.textContent; el.textContent = msg;
    setTimeout(() => { if (el.textContent === msg) el.textContent = prev; }, 2200);
  }

  /* ============================================================
     WIRING
     ============================================================ */
  function init() {
    me.id = myPid();
    const onlineBtn = $("btn-online");
    if (onlineBtn) onlineBtn.addEventListener("click", openLobby);
    $("mp-back").addEventListener("click", () => { detachRoom(); show("screen-intro"); });
    $("mp-create").addEventListener("click", createRoom);
    $("mp-join").addEventListener("click", joinRoom);
    $("mp-code").addEventListener("input", (e) => (e.target.value = e.target.value.toUpperCase()));
    $("mp-copycode").addEventListener("click", () => { if (me.code) navigator.clipboard && navigator.clipboard.writeText(me.code); flashStatus("Code copied: " + me.code); });
    document.querySelectorAll(".mp-role").forEach((b) => b.addEventListener("click", () => claimRole(b.getAttribute("data-role"))));
    $("mp-start").addEventListener("click", startGame);
    $("mp-leave").addEventListener("click", () => leaveRoom(false));
    $("mp-playagain").addEventListener("click", () => {
      // host resets the room back to lobby; others just wait
      if (me.isHost && roomRef) roomRef.update({ "meta/phase": "lobby", "meta/subphase": "smuggler", "meta/round": 1, "results": null, "turns": null });
      else show("screen-mp-lobby");
    });
    $("mp-home").addEventListener("click", () => leaveRoom(true));
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
