/* ============================================================
   Seshachalam Guardian — game engine (dynamic edition)
   A game-theoretic simulation of red sandalwood conservation.
   ============================================================ */
(function () {
  "use strict";

  /* ---------------- Constants / tuning ---------------- */
  const CONFIG = {
    TOTAL_ROUNDS: 10,
    START_FOREST: 100,
    TREES_PER_POACH: 3,
    PHASE1_END: 3,
    ESCROW_START: 4,
    ESCROW_WAGE: 10,
    BAN_BRIBE: 20,
    ESCROW_BRIBE: 20,
    CITES_START: 6,
    CITES_END: 8,
    CITES_BUFFER_START: 2,
    CITES_BRIBE: { 6: 20, 7: 40, 8: 60 },
    PENALTY_PER_CHEATER: 4,
    // pacing (ms) — gives the round weight & suspense
    REVEAL_THINK: 650,
    REVEAL_STEP: 620,
    REVEAL_AFTER: 520,
  };

  /* ---------------- Bot personalities ----------------
     Each returns a POACH probability (0..1); difficulty scales it. */
  const PERSONALITIES = {
    riskAverse: {
      key: "riskAverse", emoji: "🛖", tag: "Risk-Averse",
      blurb: "Fears the state. Guards unless starving.",
      prob(ctx, self) {
        const starving = self.cash <= 5;
        const desperate = self.cash <= 0;
        const bigBribe = ctx.bribe >= 40;
        if (desperate) return 0.55;
        if (starving && bigBribe) return 0.45;
        if (ctx.escrowCollapsed && bigBribe) return 0.5;
        return 0.05;
      },
    },
    hyperbolic: {
      key: "hyperbolic", emoji: "🏕️", tag: "Hyperbolic Discounter",
      blurb: "Wants cash NOW. Loves a fat bribe.",
      prob(ctx, self) {
        let p = ctx.bribe / 70;
        if (ctx.escrowActive && !ctx.escrowCollapsed) p -= 0.18;
        if (ctx.escrowCollapsed) p += 0.2;
        if (self.cash <= 0) p += 0.15;
        return p;
      },
    },
    opportunistic: {
      key: "opportunistic", emoji: "🏚️", tag: "Opportunistic",
      blurb: "Cold calculator. Cheats when risk is low.",
      prob(ctx, self) {
        let p;
        if (!ctx.escrowActive) p = 0.55;
        else if (ctx.escrowCollapsed) p = 0.8;
        else p = 0.2 + (ctx.bribe - 20) / 120;
        if (ctx.lastRoundCheaters > 0 && ctx.escrowActive) p += 0.1;
        return p;
      },
    },
    conditional: {
      key: "conditional", emoji: "⛺", tag: "Conditional Co-operator",
      blurb: "Mirrors the village. Cheats if others did.",
      prob(ctx, self) {
        if (!ctx.escrowActive) return ctx.lastRoundCheaters >= 2 ? 0.6 : 0.25;
        if (ctx.escrowCollapsed && ctx.bribe >= 60) return 0.55;
        if (ctx.lastRoundCheaters >= 2) return 0.5;
        if (ctx.lastRoundCheaters === 1) return 0.2;
        return 0.05;
      },
    },
  };

  /* ---------------- Difficulty presets ---------------- */
  const DIFFICULTY = {
    easy:   { label: "Easy",   aggro: 0.62, wage: 12, penalty: 3 },
    normal: { label: "Normal", aggro: 1.0,  wage: 10, penalty: 4 },
    hard:   { label: "Hard",   aggro: 1.4,  wage: 8,  penalty: 5 },
  };
  let selectedDifficulty = "normal";

  /* ---------------- Helpers ---------------- */
  const $ = (id) => document.getElementById(id);
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function show(screenId) {
    document.querySelectorAll(".screen").forEach((el) => el.classList.remove("active"));
    $(screenId).classList.add("active");
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }
  // sleep that resolves early when the player clicks to skip, and bails on restart
  function sleep(ms) {
    return new Promise((resolve) => {
      const gen = S.gen;
      const start = performance.now();
      (function check() {
        if (!S || S.gen !== gen) return resolve();
        if (S.skip || performance.now() - start >= ms) return resolve();
        requestAnimationFrame(check);
      })();
    });
  }

  /* ============================================================
     AUDIO ENGINE — synthesized via Web Audio (no files needed)
     ============================================================ */
  const Sound = (function () {
    let actx = null, master = null, muted = false, noiseBuf = null;
    try { muted = localStorage.getItem("sg_muted") === "1"; } catch (e) {}

    function ensure() {
      if (!actx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return false;
        actx = new AC();
        master = actx.createGain();
        master.gain.value = 0.5;
        master.connect(actx.destination);
        // pre-build a white-noise buffer
        const n = actx.sampleRate * 1.2;
        noiseBuf = actx.createBuffer(1, n, actx.sampleRate);
        const d = noiseBuf.getChannelData(0);
        for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
      }
      if (actx.state === "suspended") actx.resume();
      return true;
    }
    function tone(o) {
      if (!actx) return;
      const t0 = actx.currentTime + (o.delay || 0);
      const osc = actx.createOscillator();
      const g = actx.createGain();
      osc.type = o.type || "sine";
      osc.frequency.setValueAtTime(o.freq, t0);
      if (o.slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.slideTo), t0 + o.dur);
      const vol = o.vol == null ? 0.3 : o.vol;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol, t0 + (o.attack || 0.006));
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
      osc.connect(g); g.connect(master);
      osc.start(t0); osc.stop(t0 + o.dur + 0.02);
    }
    function noise(o) {
      if (!actx) return;
      const t0 = actx.currentTime + (o.delay || 0);
      const src = actx.createBufferSource();
      src.buffer = noiseBuf;
      const filt = actx.createBiquadFilter();
      filt.type = o.filterType || "lowpass";
      filt.frequency.setValueAtTime(o.filter || 800, t0);
      if (o.filterTo) filt.frequency.exponentialRampToValueAtTime(o.filterTo, t0 + o.dur);
      const g = actx.createGain();
      const vol = o.vol == null ? 0.3 : o.vol;
      g.gain.setValueAtTime(vol, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
      src.connect(filt); filt.connect(g); g.connect(master);
      src.start(t0); src.stop(t0 + o.dur + 0.02);
    }

    const LIB = {
      click() { tone({ freq: 520, dur: 0.07, type: "triangle", vol: 0.16 }); },
      coin() { tone({ freq: 880, dur: 0.09, type: "triangle", vol: 0.22 });
               tone({ freq: 1320, dur: 0.12, type: "triangle", vol: 0.2, delay: 0.07 }); },
      cash() { [784, 988, 1318].forEach((f, i) => tone({ freq: f, dur: 0.16, type: "triangle", vol: 0.2, delay: i * 0.06 })); },
      wage() { tone({ freq: 587, dur: 0.16, type: "sine", vol: 0.16 });
               tone({ freq: 880, dur: 0.16, type: "sine", vol: 0.12, delay: 0.05 }); },
      treefall() { noise({ dur: 0.5, filter: 1600, filterTo: 200, vol: 0.32, filterType: "lowpass" });
                   tone({ freq: 180, slideTo: 55, dur: 0.45, type: "sine", vol: 0.3 });
                   noise({ dur: 0.08, filter: 3000, vol: 0.2, filterType: "highpass" }); }, // crack
      alarm() { tone({ freq: 740, dur: 0.18, type: "sawtooth", vol: 0.16 });
                tone({ freq: 560, dur: 0.22, type: "sawtooth", vol: 0.16, delay: 0.2 }); },
      whoosh() { noise({ dur: 0.35, filter: 300, filterTo: 2200, vol: 0.14, filterType: "bandpass" }); },
      warn() { tone({ freq: 320, slideTo: 160, dur: 0.5, type: "sawtooth", vol: 0.2 }); },
      collapse() { tone({ freq: 140, slideTo: 36, dur: 1.4, type: "sine", vol: 0.4 });
                   noise({ dur: 1.2, filter: 600, filterTo: 80, vol: 0.3, filterType: "lowpass" }); },
      win() { [523, 659, 784, 1047].forEach((f, i) => tone({ freq: f, dur: 0.4, type: "triangle", vol: 0.22, delay: i * 0.13 })); },
      lose() { [392, 330, 262].forEach((f, i) => tone({ freq: f, dur: 0.5, type: "sine", vol: 0.22, delay: i * 0.18 })); },
    };

    return {
      unlock() { ensure(); },
      isMuted() { return muted; },
      toggle() {
        muted = !muted;
        try { localStorage.setItem("sg_muted", muted ? "1" : "0"); } catch (e) {}
        if (!muted) ensure();
        return muted;
      },
      play(name) {
        if (muted) return;
        if (!ensure()) return;
        const fn = LIB[name];
        if (fn) fn();
      },
    };
  })();

  /* ---------------- Game state ---------------- */
  let S = null;
  let genCounter = 0;

  function freshState() {
    const botKeys = ["riskAverse", "hyperbolic", "opportunistic", "conditional"];
    const villages = [
      { id: 1, name: "Your Village", emoji: "🏡", tag: "You", isPlayer: true, cash: 0, lastAction: null },
    ];
    botKeys.forEach((k, i) => {
      villages.push({
        id: i + 2, name: "Village " + (i + 2), emoji: PERSONALITIES[k].emoji,
        tag: PERSONALITIES[k].tag, blurb: PERSONALITIES[k].blurb,
        isPlayer: false, personality: k, cash: 0, lastAction: null,
      });
    });
    return {
      gen: ++genCounter,
      round: 1, forest: CONFIG.START_FOREST, villages,
      lastRoundCheaters: 0, citesBuffer: CONFIG.CITES_BUFFER_START,
      escrowCollapsed: false, gameOver: false, history: [],
      revealing: false, skip: false,
      villageEls: [],
      prevPhase: null,
      diff: DIFFICULTY[selectedDifficulty] || DIFFICULTY.normal,
      diffKey: selectedDifficulty,
      // visual
      trees: [], particles: [],
      forestVisual: CONFIG.START_FOREST, // smoothly animated number for HUD/meter
      hudCashShown: 0,
    };
  }

  /* ---------------- Round context ---------------- */
  function roundContext(s) {
    const r = s.round;
    const escrowActive = r >= CONFIG.ESCROW_START;
    const inCites = r >= CONFIG.CITES_START && r <= CONFIG.CITES_END;
    let bribe;
    if (!escrowActive) bribe = CONFIG.BAN_BRIBE;
    else if (inCites) bribe = CONFIG.CITES_BRIBE[r];
    else bribe = CONFIG.ESCROW_BRIBE;
    const baseWage = s.diff ? s.diff.wage : CONFIG.ESCROW_WAGE;
    const penalty = s.diff ? s.diff.penalty : CONFIG.PENALTY_PER_CHEATER;
    let wage = 0;
    if (escrowActive) {
      wage = s.escrowCollapsed ? 0 : Math.max(0, baseWage - s.lastRoundCheaters * penalty);
    }
    return {
      round: r, escrowActive, inCites, bribe, wage,
      escrowCollapsed: s.escrowCollapsed, lastRoundCheaters: s.lastRoundCheaters,
      phase: !escrowActive ? "ban" : inCites ? "cites" : "escrow",
    };
  }

  /* ============================================================
     FOREST CANVAS — animated render loop
     ============================================================ */
  const canvas = $("forest-canvas");
  const ctx2d = canvas.getContext("2d");
  const CW = canvas.width, CH = canvas.height;

  // deterministic tree layout + a shuffled fell-order so thinning looks scattered
  const TREE_LAYOUT = (function () {
    const slots = [];
    const cols = 14, rows = 8;
    let seed = 1337;
    const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const jx = (rnd() - 0.5) * 22;
        const jy = (rnd() - 0.5) * 14;
        const x = 24 + (col + 0.5) * ((CW - 48) / cols) + jx;
        const y = 60 + (row + 0.5) * ((CH - 80) / rows) + jy;
        const scale = 0.7 + (row / rows) * 0.7 + rnd() * 0.2;
        slots.push({ x, y, scale, depth: row, swayPhase: rnd() * Math.PI * 2, swaySpeed: 0.6 + rnd() * 0.7 });
      }
    }
    slots.sort((a, b) => a.depth - b.depth); // back-to-front draw order
    // assign random fell ranks (which trees disappear first)
    const ranks = slots.map((_, i) => i);
    for (let i = ranks.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [ranks[i], ranks[j]] = [ranks[j], ranks[i]];
    }
    slots.forEach((s, i) => (s.fellRank = ranks[i]));
    return slots;
  })();

  function initTrees() {
    S.trees = TREE_LAYOUT.map((slot) => ({
      slot, alive: true, falling: false, fallT: 0, gone: false,
    }));
    syncForestVisual(true);
  }

  // recompute which trees should stand; trigger fall animations for the newly felled
  function syncForestVisual(instant) {
    const n = S.trees.length;
    const aliveTarget = Math.round((Math.max(0, S.forest) / CONFIG.START_FOREST) * n);
    S.trees.forEach((t) => {
      const shouldStand = t.slot.fellRank < aliveTarget;
      if (!shouldStand && t.alive && !t.falling && !t.gone) {
        if (instant) { t.alive = false; t.gone = true; }
        else {
          t.falling = true;
          spawnLeaves(t.slot.x, t.slot.y - 24 * t.slot.scale, 6);
        }
      } else if (shouldStand && (t.gone || !t.alive) && instant) {
        t.alive = true; t.falling = false; t.fallT = 0; t.gone = false;
      }
    });
  }

  /* ----- particles: fireflies (calm), embers (crisis), leaves (fell) ----- */
  function spawnLeaves(x, y, count) {
    for (let i = 0; i < count; i++) {
      S.particles.push({
        type: "leaf", x, y,
        vx: (Math.random() - 0.5) * 40, vy: 20 + Math.random() * 40,
        life: 0, maxLife: 1.4 + Math.random() * 0.8,
        size: 3 + Math.random() * 3, rot: Math.random() * 6.28, vrot: (Math.random() - 0.5) * 6,
        color: Math.random() < 0.5 ? "#c47a3a" : "#7fae5a",
      });
    }
  }
  function spawnEmber() {
    S.particles.push({
      type: "ember", x: Math.random() * CW, y: CH + 6,
      vx: (Math.random() - 0.5) * 12, vy: -(18 + Math.random() * 34),
      life: 0, maxLife: 2.2 + Math.random() * 1.8, size: 1 + Math.random() * 2,
      color: Math.random() < 0.5 ? "#ff7a3a" : "#ffae5a",
    });
  }
  function spawnFirefly() {
    S.particles.push({
      type: "fly", x: Math.random() * CW, y: 80 + Math.random() * (CH - 110),
      vx: (Math.random() - 0.5) * 14, vy: (Math.random() - 0.5) * 10,
      life: 0, maxLife: 3 + Math.random() * 3, size: 1.4 + Math.random() * 1.6,
      phase: Math.random() * 6.28,
    });
  }

  function updateParticles(dt, inCites) {
    // ambient spawns
    if (inCites) { if (Math.random() < dt * 14) spawnEmber(); }
    else { if (Math.random() < dt * 2.2 && S.particles.filter(p => p.type === "fly").length < 14) spawnFirefly(); }

    for (let i = S.particles.length - 1; i >= 0; i--) {
      const p = S.particles[i];
      p.life += dt;
      if (p.type === "leaf") {
        p.vy += 30 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vrot * dt;
        p.vx *= 0.98;
      } else if (p.type === "ember") {
        p.x += p.vx * dt; p.y += p.vy * dt; p.vy *= 0.995;
      } else {
        p.phase += dt * 3;
        p.x += p.vx * dt + Math.sin(p.phase) * 6 * dt;
        p.y += p.vy * dt + Math.cos(p.phase * 0.7) * 5 * dt;
        if (p.x < 10 || p.x > CW - 10) p.vx *= -1;
        if (p.y < 70 || p.y > CH - 20) p.vy *= -1;
      }
      if (p.life >= p.maxLife) S.particles.splice(i, 1);
    }
  }

  function drawTreeShape(c, t, now) {
    const s = t.slot;
    const sway = Math.sin(now * 0.001 * s.swaySpeed + s.swayPhase) * 0.05;
    const scale = s.scale;
    const h = 34 * scale, w = 16 * scale;

    if (t.gone) {
      // stump
      c.fillStyle = "rgba(120,70,45,0.5)";
      c.fillRect(s.x - 3 * scale, s.y - 2, 6 * scale, 8 * scale);
      return;
    }

    c.save();
    c.translate(s.x, s.y + 10 * scale);
    if (t.falling) {
      const tt = clamp(t.fallT, 0, 1);
      c.rotate(tt * 1.35 * (s.fellRank % 2 ? 1 : -1)); // topple sideways
      c.globalAlpha = 1 - tt * 0.9;
    } else {
      c.rotate(sway);
    }
    c.translate(0, -10 * scale);

    // trunk
    c.fillStyle = "#5b3a22";
    c.fillRect(-2 * scale, 0, 4 * scale, 10 * scale);
    // canopy
    const grad = c.createLinearGradient(0, -h, 0, 0);
    grad.addColorStop(0, "#46bd7e");
    grad.addColorStop(1, "#1c6b43");
    c.fillStyle = grad;
    c.beginPath(); c.moveTo(0, -h); c.lineTo(-w, 0); c.lineTo(w, 0); c.closePath(); c.fill();
    c.beginPath(); c.moveTo(0, -h * 1.25); c.lineTo(-w * 0.8, -h * 0.45); c.lineTo(w * 0.8, -h * 0.45); c.closePath(); c.fill();
    c.restore();
  }

  function drawScene(now, dt) {
    const c = ctx2d;
    const ctxR = roundContext(S);
    const inCites = ctxR.inCites;

    // advance falling trees
    S.trees.forEach((t) => {
      if (t.falling) {
        t.fallT += dt * 1.6;
        if (t.fallT >= 1) { t.falling = false; t.gone = true; t.alive = false; }
      }
    });
    updateParticles(dt, inCites);

    // sky / ground
    c.clearRect(0, 0, CW, CH);
    const g = c.createLinearGradient(0, 0, 0, CH);
    if (inCites) { g.addColorStop(0, "#2a160f"); g.addColorStop(1, "#160a08"); }
    else { g.addColorStop(0, "#13301f"); g.addColorStop(1, "#0a160f"); }
    c.fillStyle = g; c.fillRect(0, 0, CW, CH);

    // drifting mist band
    const mistY = 50 + Math.sin(now * 0.0004) * 8;
    c.fillStyle = inCites ? "rgba(200,90,60,0.06)" : "rgba(120,200,150,0.05)";
    c.fillRect(0, mistY, CW, 70);

    // moon / haze glow
    c.save();
    const glow = c.createRadialGradient(CW * 0.8, 50, 5, CW * 0.8, 50, 120);
    glow.addColorStop(0, inCites ? "rgba(255,120,80,0.16)" : "rgba(180,230,200,0.12)");
    glow.addColorStop(1, "rgba(0,0,0,0)");
    c.fillStyle = glow; c.fillRect(0, 0, CW, CH);
    c.restore();

    // trees (already in back-to-front order)
    S.trees.forEach((t) => drawTreeShape(c, t, now));

    // particles
    S.particles.forEach((p) => {
      const k = 1 - p.life / p.maxLife;
      if (p.type === "leaf") {
        c.save(); c.translate(p.x, p.y); c.rotate(p.rot); c.globalAlpha = clamp(k, 0, 1);
        c.fillStyle = p.color; c.beginPath();
        c.ellipse(0, 0, p.size, p.size * 0.5, 0, 0, 6.28); c.fill(); c.restore();
      } else if (p.type === "ember") {
        c.globalAlpha = clamp(k, 0, 1); c.fillStyle = p.color;
        c.beginPath(); c.arc(p.x, p.y, p.size, 0, 6.28); c.fill(); c.globalAlpha = 1;
      } else {
        const tw = 0.5 + 0.5 * Math.sin(p.phase * 2);
        c.globalAlpha = clamp(k, 0, 1) * tw * 0.9; c.fillStyle = "#d7ff9e";
        c.beginPath(); c.arc(p.x, p.y, p.size, 0, 6.28); c.fill();
        c.globalAlpha = clamp(k, 0, 1) * tw * 0.25;
        c.beginPath(); c.arc(p.x, p.y, p.size * 3, 0, 6.28); c.fill(); c.globalAlpha = 1;
      }
    });

    // collapse overlay
    if (S.forest <= 0) {
      c.fillStyle = "rgba(140,47,40,0.4)"; c.fillRect(0, 0, CW, CH);
      c.fillStyle = "#ff8a80"; c.font = "bold 26px Cinzel, serif"; c.textAlign = "center";
      c.fillText("ECOLOGICAL COLLAPSE", CW / 2, CH / 2);
    }
  }

  let lastT = 0;
  function loop(now) {
    if (!S) { requestAnimationFrame(loop); return; }
    const dt = Math.min(0.05, (now - lastT) / 1000 || 0);
    lastT = now;
    if ($("screen-game").classList.contains("active") && S.trees.length) {
      // smooth HUD forest number + meter
      S.forestVisual = lerp(S.forestVisual, Math.max(0, S.forest), 1 - Math.pow(0.001, dt));
      updateForestHud();
      drawScene(now, dt);
    }
    requestAnimationFrame(loop);
  }

  function updateForestHud() {
    const shown = Math.round(S.forestVisual);
    $("hud-forest").textContent = shown;
    $("forest-badge").textContent = shown + " trees standing";
    const pct = clamp((S.forestVisual / CONFIG.START_FOREST) * 100, 0, 100);
    const fill = $("forest-meter-fill");
    fill.style.width = pct + "%";
    if (pct <= 20) fill.style.background = "linear-gradient(90deg,#8c2f28,#ef5350)";
    else if (pct <= 45) fill.style.background = "linear-gradient(90deg,#9a6a1e,#e7b85c)";
    else fill.style.background = "linear-gradient(90deg,#1f7a4d,#4fd18b)";
  }

  /* ============================================================
     FX LAYER — floating numbers, toasts, shake
     ============================================================ */
  let fxLayer;
  function ensureFx() {
    if (!fxLayer) {
      fxLayer = document.createElement("div");
      fxLayer.className = "fx-layer";
      document.body.appendChild(fxLayer);
    }
  }
  function floatText(text, x, y, cls) {
    ensureFx();
    const el = document.createElement("div");
    el.className = "float-num " + (cls || "");
    el.textContent = text;
    el.style.left = x + "px";
    el.style.top = y + "px";
    fxLayer.appendChild(el);
    setTimeout(() => el.remove(), 1300);
  }
  function floatOverEl(el, text, cls) {
    const r = el.getBoundingClientRect();
    floatText(text, r.left + r.width / 2, r.top + 18, cls);
  }
  function floatOverCanvas(text, cls) {
    const r = canvas.getBoundingClientRect();
    floatText(text, r.left + r.width / 2 + (Math.random() - 0.5) * 120, r.top + r.height * 0.5, cls);
  }
  function shake(strength) {
    const el = $("screen-game");
    el.classList.remove("shake-sm", "shake-lg");
    void el.offsetWidth;
    el.classList.add(strength === "lg" ? "shake-lg" : "shake-sm");
    setTimeout(() => el.classList.remove("shake-sm", "shake-lg"), 600);
  }
  let toastEl;
  function phaseToast(title, sub, variant) {
    ensureFx();
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "phase-toast";
      document.body.appendChild(toastEl);
    }
    toastEl.className = "phase-toast " + (variant || "");
    toastEl.innerHTML = '<div class="pt-title">' + title + '</div><div class="pt-sub">' + sub + "</div>";
    void toastEl.offsetWidth;
    toastEl.classList.add("show");
    setTimeout(() => toastEl.classList.remove("show"), 2200);
  }

  /* ---------------- animated counter ---------------- */
  function animateCount(el, from, to, dur) {
    const start = performance.now();
    const gen = S.gen;
    (function step(now) {
      if (!S || S.gen !== gen) return;
      const t = clamp((now - start) / dur, 0, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = Math.round(lerp(from, to, eased));
      if (t < 1) requestAnimationFrame(step);
    })(start);
  }

  /* ============================================================
     ROUND UI (resting state at start of a round)
     ============================================================ */
  function renderRoundUI() {
    const ctxR = roundContext(S);
    $("hud-round").textContent = S.round + " / " + CONFIG.TOTAL_ROUNDS;
    $("hud-cash").textContent = S.villages[0].cash;
    S.hudCashShown = S.villages[0].cash;

    // banner
    const banner = $("phase-banner"), txt = $("phase-banner-text");
    banner.classList.remove("escrow", "crisis");
    if (ctxR.phase === "ban") txt.innerHTML = "Phase 1 · Command &amp; Control State Ban";
    else if (ctxR.phase === "cites") { banner.classList.add("crisis"); txt.innerHTML = "🚨 CITES EXPORT FREEZE · Round " + S.round + " · The Squeeze Is On"; }
    else { banner.classList.add("escrow"); txt.innerHTML = "Phase 2 · Pre-Funded International Escrow"; }

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
    } else alert.hidden = true;

    // buttons
    $("guard-sub").textContent = ctxR.escrowActive
      ? (ctxR.wage > 0 ? "+" + ctxR.wage + " cash (escrow)" : "+0 cash (escrow depleted)")
      : "+0 cash";
    $("poach-sub").textContent = "+" + ctxR.bribe + " cash · −" + CONFIG.TREES_PER_POACH + " trees";

    // smuggler
    const offer = $("smuggler-offer");
    if (ctxR.phase === "cites") {
      offer.textContent = {
        6: '"The borders are closing. +20 now, before the escrow dries up."',
        7: '"No exports, no escrow refill. Double or nothing — +40 cash."',
        8: '"Last chance. The reserve is empty. +60 cash. Everyone is cracking."',
      }[S.round];
    } else if (ctxR.escrowActive) {
      offer.textContent = '"A quiet +' + ctxR.bribe + ' cash. The DNA ledger? Who reads it, really?"';
    } else {
      offer.textContent = '"+' + ctxR.bribe + ' cash to look away. Three trees, gone. The guards are far."';
    }

    buildVillages();

    // phase transition announcements
    if (S.prevPhase !== ctxR.phase || S.round === 1) {
      if (S.round === CONFIG.ESCROW_START) {
        phaseToast("🤝 Escrow Goes Live", "Guarding now pays a guaranteed wage. Cheaters drag everyone down.", "escrow");
        Sound.play("whoosh");
      } else if (S.round === CONFIG.CITES_START) {
        phaseToast("🚨 CITES Export Freeze", "Trade is locked. The escrow buffer is draining. The squeeze begins.", "crisis");
        Sound.play("alarm");
      }
    }
    if (ctxR.phase === "cites" && S.round > CONFIG.CITES_START) {
      phaseToast("💰 The Smuggler Doubles Down", "Bribe rises to +" + ctxR.bribe + " cash. Buffer: " + Math.max(0, S.citesBuffer) + " turns left.", "crisis");
      Sound.play("alarm");
    }
    if (S.round === CONFIG.CITES_END + 1 && ctxR.phase === "escrow") {
      phaseToast("🕊️ Trade Routes Reopen", "The freeze lifts. Escrow can refill — if the forest survived.", "escrow");
      Sound.play("whoosh");
    }
    S.prevPhase = ctxR.phase;
  }

  function buildVillages() {
    const wrap = $("villages");
    wrap.innerHTML = "";
    S.villageEls = [];
    S.villages.forEach((v) => {
      const el = document.createElement("div");
      el.className = "village" + (v.isPlayer ? " you" : "");
      const tagLine = v.isPlayer ? "That's you" : v.tag;
      const blurb = v.isPlayer ? "Your call this round" : (v.blurb || "");
      let statusHtml = '<div class="v-status">Awaiting orders</div>';
      if (v.lastAction === "guard") statusHtml = '<div class="v-status guard">🛡️ Guarded last round</div>';
      else if (v.lastAction === "poach") statusHtml = '<div class="v-status poach">🪓 Poached last round</div>';
      el.innerHTML =
        '<div class="v-top">' +
          '<span class="v-emoji">' + v.emoji + '</span>' +
          '<span class="v-name">' + v.name + '</span>' +
          '<span class="v-tag">' + tagLine + '<br>' + escapeHtml(blurb) + "</span>" +
        "</div>" +
        '<div class="v-cash">Cash: <b>' + v.cash + "</b></div>" +
        statusHtml;
      wrap.appendChild(el);
      S.villageEls.push(el);
    });
  }

  function setVillageStatus(el, html, cls) {
    const st = el.querySelector(".v-status");
    st.className = "v-status " + (cls || "");
    st.innerHTML = html;
  }

  /* ============================================================
     CHOICE + STAGED REVEAL
     ============================================================ */
  function computeDecisions(playerPoached) {
    const ctxR = roundContext(S);
    const aggro = S.diff ? S.diff.aggro : 1;
    const decisions = [{ v: S.villages[0], poach: playerPoached }];
    for (let i = 1; i < S.villages.length; i++) {
      const v = S.villages[i];
      const p = clamp(PERSONALITIES[v.personality].prob(ctxR, v) * aggro, 0.02, 0.97);
      decisions.push({ v, poach: Math.random() < p });
    }
    return { ctxR, decisions };
  }

  async function onChoice(poach) {
    if (!S || S.gameOver || S.revealing) return;
    S.revealing = true; S.skip = false;
    setDecisionEnabled(false);

    const { ctxR, decisions } = computeDecisions(poach);

    // mark all villages "deciding"
    S.villageEls.forEach((el, i) => {
      el.classList.add("deciding");
      setVillageStatus(el, "deciding<span class='dots'></span>", "");
    });
    await sleep(CONFIG.REVEAL_THINK);

    let cheaters = 0, treesLost = 0;

    // reveal one at a time
    for (let i = 0; i < decisions.length; i++) {
      if (!S || S.gen == null) return;
      const d = decisions[i];
      const el = S.villageEls[i];
      const gain = d.poach ? ctxR.bribe : ctxR.wage;

      el.classList.remove("deciding");
      el.classList.add("just-revealed");
      setTimeout(() => el && el.classList.remove("just-revealed"), 420);

      if (d.poach) {
        setVillageStatus(el, "🪓 Poached", "poach");
        d.v.cash += ctxR.bribe; cheaters++; treesLost += CONFIG.TREES_PER_POACH;
        S.forest = Math.max(0, S.forest - CONFIG.TREES_PER_POACH);
        syncForestVisual(false);
        floatOverEl(el, "+" + ctxR.bribe, "cash");
        floatOverCanvas("−" + CONFIG.TREES_PER_POACH + " 🌲", "tree");
        shake(ctxR.inCites ? "lg" : "sm");
        Sound.play("treefall");
        if (d.v.isPlayer) Sound.play("cash");
      } else {
        setVillageStatus(el, "🛡️ Guarded", "guard");
        d.v.cash += gain;
        if (gain > 0) { floatOverEl(el, "+" + gain, "wage"); if (d.v.isPlayer) Sound.play("coin"); }
        else floatOverEl(el, "+0", "muted");
      }
      // update that village's cash text
      const cashB = el.querySelector(".v-cash b");
      if (cashB) cashB.textContent = d.v.cash;
      // player's HUD cash
      if (d.v.isPlayer) {
        animateCount($("hud-cash"), S.hudCashShown, d.v.cash, 450);
        S.hudCashShown = d.v.cash;
        $("hud-cash").classList.add("bump");
        setTimeout(() => $("hud-cash").classList.remove("bump"), 350);
      }
      d.v.lastAction = d.poach ? "poach" : "guard";
      await sleep(CONFIG.REVEAL_STEP);
    }

    await sleep(CONFIG.REVEAL_AFTER);

    // CITES buffer drain
    let bufferNote = null;
    if (ctxR.inCites) {
      S.citesBuffer -= 1;
      $("cites-buffer").textContent = Math.max(0, S.citesBuffer);
      if (S.citesBuffer <= 0 && !S.escrowCollapsed) {
        S.escrowCollapsed = true;
        bufferNote = "The emergency escrow buffer is exhausted — the legal safety net is gone.";
        phaseToast("🪙 Escrow Buffer Empty", "No safety net left. Guarding now pays nothing.", "crisis");
        Sound.play("warn");
      }
    }
    S.lastRoundCheaters = cheaters;

    const record = { round: S.round, ctxR, decisions, cheaters, treesLost, bufferNote };
    S.history.push(record);
    addLogLine(record);

    S.revealing = false;
    showResolution(record);
  }

  /* ---------------- Resolution summary modal ---------------- */
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
        '<span class="rr-name">' + d.v.emoji + " " + (d.v.isPlayer ? "You" : "V" + d.v.id) + "</span>" +
        '<span class="rr-act ' + (d.poach ? "poach" : "guard") + '">' + (d.poach ? "🪓 Poached" : "🛡️ Guarded") + "</span>" +
        '<span class="rr-delta">+' + gain + " cash</span>";
      log.appendChild(row);
    });

    let html = "";
    html += treesLost > 0
      ? '<span class="neg">' + cheaters + " village" + (cheaters > 1 ? "s" : "") + " poached — " + treesLost + " trees felled.</span> "
      : '<span class="pos">The whole village held the line. No trees lost.</span> ';
    if (ctxR.escrowActive && !ctxR.escrowCollapsed) {
      if (cheaters > 0) {
        const penalty = S.diff ? S.diff.penalty : CONFIG.PENALTY_PER_CHEATER;
        const baseWage = S.diff ? S.diff.wage : CONFIG.ESCROW_WAGE;
        const cut = cheaters * penalty;
        html += "The DNA ledger flagged the illicit timber. <strong>Next round's escrow wage is cut by " + cut + " (to " + Math.max(0, baseWage - cut) + ").</strong> ";
      } else html += "Clean ledger — full escrow wage restored next round. ";
    }
    if (bufferNote) html += '<br><span class="neg">⚠️ ' + bufferNote + "</span>";
    if (S.forest <= 0) html += '<br><span class="neg">The forest is gone.</span>';
    $("res-summary").innerHTML = html;

    $("resolution").hidden = false;
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

  /* ---------------- Flow ---------------- */
  function startGame() {
    S = freshState();
    $("event-log").innerHTML = "";
    if (fxLayer) fxLayer.innerHTML = "";
    initTrees();
    S.forestVisual = CONFIG.START_FOREST;
    // difficulty pill
    const pill = $("diff-pill");
    if (pill) { pill.textContent = S.diff.label; pill.className = "diff-pill " + S.diffKey; }
    Sound.unlock();
    Sound.play("whoosh");
    show("screen-game");
    renderRoundUI();
    setDecisionEnabled(true);
  }

  function setDecisionEnabled(on) {
    $("btn-guard").disabled = !on;
    $("btn-poach").disabled = !on;
  }

  function nextRound() {
    $("resolution").hidden = true;
    if (S.forest <= 0) return endGame(false);
    if (S.round >= CONFIG.TOTAL_ROUNDS) return endGame(true);
    S.round += 1;
    renderRoundUI();
    setDecisionEnabled(true);
  }

  /* ---------------- End game ---------------- */
  function endGame(survived) {
    S.gameOver = true;
    const player = S.villages[0];
    const forest = Math.max(0, S.forest);
    const score = Math.round(player.cash * 1 + forest * 6);
    const card = $("over-card");
    card.classList.remove("win", "lose");

    let title, text, emblem;
    if (!survived) {
      card.classList.add("lose"); emblem = "🪵"; title = "Ecological Collapse";
      text = "The last red sandalwood fell. The smuggler moves on; the hills fall silent. Short-term cash could not buy back a dead forest — the tragedy of the commons, complete.";
    } else if (forest >= 70) {
      card.classList.add("win"); emblem = "🌳🛡️"; title = "Guardian of the Hills";
      text = "You held the commons together through the CITES squeeze. The escrow and peer enforcement held where the state ban failed. This is Ostrom's lesson made real.";
    } else if (forest >= 35) {
      card.classList.add("win"); emblem = "🌲"; title = "The Forest Endures";
      text = "Battered but standing. The community bent under the 60-cash squeeze yet avoided total collapse. A fragile, hard-won cooperation.";
    } else {
      card.classList.add("lose"); emblem = "🍂"; title = "A Hollow Survival";
      text = "The forest technically survived the ten rounds, but barely. Another season of this and the commons would be gone. Cooperation frayed when the safety net disappeared.";
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
    Sound.play(survived && card.classList.contains("win") ? "win" : "lose");
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
    $("btn-start").addEventListener("click", () => { Sound.unlock(); startGame(); });
    $("btn-playagain").addEventListener("click", startGame);
    $("btn-restart").addEventListener("click", () => {
      if (confirm("Restart the game? Progress will be lost.")) startGame();
    });
    $("btn-guard").addEventListener("click", () => onChoice(false));
    $("btn-poach").addEventListener("click", () => onChoice(true));
    $("btn-next").addEventListener("click", () => { Sound.play("click"); nextRound(); });

    // difficulty selector (intro screen)
    document.querySelectorAll("#difficulty-options .diff-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        selectedDifficulty = chip.getAttribute("data-diff");
        document.querySelectorAll("#difficulty-options .diff-chip").forEach((c) => c.classList.remove("active"));
        chip.classList.add("active");
        Sound.unlock(); Sound.play("click");
      });
    });

    // sound toggle
    const sbtn = $("btn-sound");
    function refreshSound() {
      const m = Sound.isMuted();
      sbtn.textContent = m ? "🔇" : "🔊";
      sbtn.classList.toggle("muted", m);
    }
    refreshSound();
    sbtn.addEventListener("click", () => { Sound.toggle(); refreshSound(); if (!Sound.isMuted()) Sound.play("click"); });

    // click anywhere during a reveal to fast-forward it (but not the click that starts the round)
    document.addEventListener("click", (e) => {
      if (S && S.revealing && !e.target.closest("#btn-guard, #btn-poach")) S.skip = true;
    });

    $("btn-how").addEventListener("click", () => $("modal-how").classList.add("open"));
    document.querySelectorAll("[data-close-modal]").forEach((b) =>
      b.addEventListener("click", () => $("modal-how").classList.remove("open"))
    );
    $("modal-how").addEventListener("click", (e) => {
      if (e.target === $("modal-how")) $("modal-how").classList.remove("open");
    });

    document.addEventListener("keydown", (e) => {
      if (!$("screen-game").classList.contains("active")) return;
      if (!$("resolution").hidden) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); Sound.play("click"); nextRound(); }
      } else if (S && S.revealing) {
        S.skip = true;
      } else {
        if (e.key.toLowerCase() === "g") onChoice(false);
        if (e.key.toLowerCase() === "p") onChoice(true);
        if (e.key.toLowerCase() === "m") { Sound.toggle(); refreshSound(); }
      }
    });

    show("screen-intro");
    requestAnimationFrame(loop);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
