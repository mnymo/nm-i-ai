# NM i AI — Grocery Bot

Competition bot for the Norwegian Championship in AI (NM i AI).
Goal: maximize score across 300 ticks by routing bots to pick up and deliver grocery items to the drop-off.

Game server: `wss://game.ainm.no/ws`
Docs/MCP: configured in `mcp.json` → `https://mcp-docs.ainm.no/mcp`

## Score Baselines

| Difficulty | Bots | Best score | Orders | Status |
|------------|------|-----------|--------|--------|
| easy       | 1    | 118       | 14     | repeatable |
| medium     | ?    | ?         | ?      | not yet run |
| hard       | ?    | ?         | ?      | not yet run |
| expert     | ?    | ?         | ?      | not yet run |

Update this table after every significant run.

Latest verified easy runs:
- `2026-03-07T15-56-13-035Z-easy-easy` -> score `118`, orders `14`, items `48`
- `2026-03-07T16-00-36-191Z-easy-easy` -> score `118`, orders `14`, items `48`
- Both runs had `0` failed pickups, `0` non-scoring dropoffs, and `0` wasted inventory at game over.

## Quick Commands

All commands run from **repo root** (`/home/magnus/Git/nm-i-ai`).

```bash
# Play live game (requires token)
node tools/grocery-bot/index.mjs --token $TOKEN --difficulty easy --profile easy

# Summarize a replay (no token needed)
node tools/grocery-bot/index.mjs --mode summarize --difficulty easy \
  --replay tools/grocery-bot/out/<run-id>/replay.jsonl

# Simulate planner changes against a saved replay (no token, fast feedback)
node tools/grocery-bot/index.mjs --mode simulate --difficulty easy --profile easy \
  --replay tools/grocery-bot/out/<run-id>/replay.jsonl

# Tune profile parameters from a replay (--seeds = search width, try 128+)
node tools/grocery-bot/index.mjs --mode tune --difficulty easy --profile easy \
  --replay tools/grocery-bot/out/<run-id>/replay.jsonl --seeds 128

# Estimate theoretical score ceiling from a replay
node tools/grocery-bot/index.mjs --mode estimate-max \
  --replay tools/grocery-bot/out/<run-id>/replay.jsonl

# Run tests
node --test tools/grocery-bot/test/*.test.mjs
```

## Key File Map

```
tools/grocery-bot/
├── index.mjs                    Entry point, mode dispatch
├── src/
│   ├── planner.mjs              planSingleBot + GroceryPlanner class — read for strategy changes
│   ├── planner-singlebot.mjs    Single-bot evaluation, recovery, cooldowns, oscillation detection
│   ├── planner-multibot.mjs     Multi-bot assignment, routing, deadlock (medium+)
│   ├── planner-utils.mjs        Shared helpers (demand, phase, congestion, path utils)
│   ├── game-client.mjs          WebSocket loop, action sanitizer, pickup tracking
│   ├── routing.mjs              Time-aware A* + path reservations (collision avoidance)
│   ├── assignment.mjs           Min-cost bot-to-item matching
│   ├── optimizer.mjs            Profile parameter search (random mutation over replay)
│   ├── replay.mjs               Logging, summarize, simulate, analysis generation
│   ├── world-model.mjs          Demand/inventory helpers
│   ├── coords.mjs               Grid geometry, move encoding
│   ├── grid-graph.mjs           Graph for pathfinding
│   ├── max-score-estimator.mjs  Theoretical score ceiling
│   ├── protocol.mjs             WebSocket message parsing/serialization
│   ├── profile.mjs              Profile loading + merging
│   └── cli.mjs                  Argument parsing
├── config/
│   └── profiles.json            Tunable parameters per difficulty (source of truth)
├── out/
│   ├── <run-id>/
│   │   ├── replay.jsonl         Slim tick-by-tick log (layout entry + diffs) — do not delete
│   │   ├── summary.json         Final score, orders, items
│   │   └── analysis.json        Compact run analysis — READ THIS first before touching code
│   └── tuned-<diff>.json        Output of tune mode (merge back into profiles.json when good)
└── test/                        Node --test unit tests
```

## Architecture

**Critical constraint:** The game server receives one unified action payload per tick covering all bots. All coordination is centralized in the planner. Do not attempt to split bot control across separate processes or network calls.

**Single-bot (easy):**
Enumerate candidate pickup-type sequences → score each by (projected delivery points − route cost − leftover-inventory penalty) → execute first step of best candidate. Recovery mode activates on stagnation.

**Multi-bot (medium/hard/expert):**
Each tick: build world context → cost-matrix assignment (each bot → item or drop-off) → time-aware A* with path reservations → deadlock detection (stall counter + forced wait/reroute) → send all actions.

**Key parameters** (`config/profiles.json` + `out/tuned-<diff>.json`):
- `assignment.congestion_penalty` / `contention_penalty` / `urgency_bonus` — shape bot-to-item assignment costs
- `routing.horizon` — lookahead depth for time-aware A*
- `anti_deadlock.stall_threshold` / `forced_wait_rounds` — deadlock recovery aggressiveness
- `recovery.*` — stagnation detection thresholds

## Development Workflow

For each improvement iteration:
1. Read `out/<run-id>/analysis.json` — compact score/pickup/stall summary, fast to read
2. Use the **replay-analyzer** subagent (`.claude/agents/replay-analyzer.md`) for deep replay digs
3. Read the relevant planner file (not all of planner.mjs — pick the right module):
   - Strategy changes → `planner.mjs` (planSingleBot + GroceryPlanner)
   - Recovery/cooldown bugs → `planner-singlebot.mjs`
   - Multi-bot routing/assignment → `planner-multibot.mjs`
4. Make the targeted change
5. Run tests: `node --test tools/grocery-bot/test/*.test.mjs`
6. Simulate offline: `--mode simulate` against the latest replay (measures action agreement, not score)
7. If change looks good → play live to confirm actual score
8. If score improves → run `--mode tune` against the new replay and merge params

## Active Improvement Backlog

Full analysis in `tools/grocery-bot/STRATEGY_REVIEW.md`. Priority order:

1. **Freeze easy winner** — treat the current `118` build as the baseline until medium work proves a better shared change
2. **Run medium, get first analysis.json** — establish the real multi-bot baseline before changing medium logic
3. **Multi-bot coordination review** — inspect assignment conflicts, deadlock recovery, and idle bots from the first medium replay
4. **Only then resume structural improvements** — shelf reliability, explicit completion lock, and additional lag guards if medium analysis justifies them

## Conventions

- All source files are `.mjs` (ESM), no transpilation, no build step
- No external npm dependencies — pure Node.js stdlib + native WebSocket
- Use `node --test` for tests, not jest/vitest
- Profiles are plain JSON — tuned outputs live in `out/`, merge manually into `config/profiles.json` after validation
- Never delete replay files — they are training data for the offline optimizer
- Keep `STRATEGY_REVIEW.md` updated with findings after each significant run
