# 🌲 Seshachalam Guardian

An interactive, game-theoretic simulation of the political economy of conservation.
You play **Village 1**, a forest-fringe cooperative sharing a living treasury of
**100 Red Sandalwood trees** with four AI-driven neighbours. Each round you choose to
**Guard** the forest or **Poach** for quick cash. If the forest hits zero, everyone loses.

The game models a classic **Prisoner's Dilemma** across two policy eras, and stress-tests
cooperation with an unexpected geopolitical shock.

## How to play

- **Phase 1 — Command & Control (Rounds 1–3):** A distant state ban. Guarding pays nothing;
  poaching pays **+20 cash** but fells **3 trees**. Fear of being the last honest villager
  drives a cascade of defection.
- **Phase 2 — Pre-Funded Escrow (Rounds 4–10):** International buyers pre-pay into a state
  escrow. Guarding earns a **guaranteed wage**. But if *anyone* cheats, the DNA ledger flags
  it and the **whole collective's payout is slashed next round** — forcing peer enforcement.
- **The CITES Stress Test (Rounds 6–8):** An export freeze locks trade. No fresh cash enters
  escrow — only a draining emergency buffer (**2 → 1 → 0** turns). Meanwhile the smuggler's
  bribe escalates: **20 → 40 → 60 cash**. This is where communities crack.

**Goal:** survive all 10 rounds with the forest standing. Your score rewards *both* personal
cash and trees saved — true mastery is getting rich **and** keeping the commons alive.

**Controls:** click **Guard** / **Poach**, or press **G** / **P**. Press **Enter** to advance.

## The AI villages

| Village | Personality | Behaviour |
|--------|-------------|-----------|
| 🛖 V2 | Risk-Averse | Guards unless starving |
| 🏕️ V3 | Hyperbolic Discounter | Poaches more as the bribe grows |
| 🏚️ V4 | Opportunistic | Cold risk/reward calculator; exploits the collapse |
| ⛺ V5 | Conditional Co-operator | Mirrors the village; retaliates against cheating |

## Run locally

It's a static site — no build step, no dependencies.

```bash
# Python
python3 -m http.server 8000      # then open http://localhost:8000

# or Node
npx serve .
```

## Deploy with GitHub Pages

1. Go to the repository's **Settings → Pages**.
2. Under **Build and deployment**, set **Source = Deploy from a branch**.
3. Choose branch **`main`** and folder **`/ (root)`**, then **Save**.
4. After a minute your game is live at:
   `https://lohithkrishan732-rgb.github.io/Seshachalam-Guardian/`

## Files

- `index.html` — structure and screens
- `styles.css` — visuals, the forest canvas styling, animations
- `game.js` — full game engine, AI personalities, and scoring
