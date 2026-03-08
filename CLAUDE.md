# NM i AI — Grocery Bot

Competition bot for the Norwegian Championship in AI (NM i AI).
Goal: maximize score across 300 ticks by routing bots to pick up and deliver grocery items to the drop-off.

Game server: `wss://game.ainm.no/ws`
Docs/MCP: configured in `mcp.json` → `https://mcp-docs.ainm.no/mcp`

## Score Baselines

Daily caveat: orders and shelf item types rotate at midnight UTC. Previous-day scores are historical references only.

| Difficulty | Bots | Best | Orders | Status |
|------------|------|------|--------|--------|
| easy       | 1    | 118  | 14     | historical |
| medium     | 3    | 115  | 12     | historical |
| hard       | 5    | 28   | 3      | historical |
| expert     | 10   | 89   | 9      | current UTC-day baseline |

Update after every significant run. Best run IDs in `out/` summary files.

## Quick Commands

All commands run from **repo root** (`/home/magnus/prog/nm-i-ai`).

```bash
# Play / inspect
node tools/grocery-bot/index.mjs --token $TOKEN --difficulty easy --profile easy
node tools/grocery-bot/index.mjs --mode runs --difficulty expert --limit 5
node tools/grocery-bot/index.mjs --mode analyze --replay tools/grocery-bot/out/<run-id>
node tools/grocery-bot/index.mjs --mode simulate --difficulty easy --profile easy --replay tools/grocery-bot/out/<run-id>/replay.jsonl
node tools/grocery-bot/index.mjs --mode script-info --script tools/grocery-bot/config/script-expert.json --oracle tools/grocery-bot/config/oracle-expert.json

# Tune / benchmark
node tools/grocery-bot/index.mjs --mode tune --difficulty easy --profile easy --replay tools/grocery-bot/out/<run-id>/replay.jsonl --seeds 128
node tools/grocery-bot/index.mjs --mode benchmark --difficulty medium --replay tools/grocery-bot/out
node tools/grocery-bot/index.mjs --mode estimate-max --replay tools/grocery-bot/out/<run-id>/replay.jsonl

# Oracle workflow (expert)
node tools/grocery-bot/extract-oracle.mjs --difficulty expert --profile expert --out tools/grocery-bot/config/oracle-expert.json
node tools/grocery-bot/generate-script.mjs --oracle tools/grocery-bot/config/oracle-expert.json --replay tools/grocery-bot/out/<run-id>/replay.jsonl --out tools/grocery-bot/config/script-expert.json
node tools/grocery-bot/optimize-oracle-script.mjs --oracle tools/grocery-bot/config/oracle-expert.json --replay tools/grocery-bot/out/<run-id>/replay.jsonl --out-script tools/grocery-bot/config/script-expert.json --out-report tools/grocery-bot/out/oracle-script-optimizer-report.json --objective handoff_first --iterations 1000
node tools/grocery-bot/compress-oracle-script.mjs --oracle tools/grocery-bot/config/oracle-expert.json --replay tools/grocery-bot/out/<run-id>/replay.jsonl --out-script tools/grocery-bot/config/script-expert.json --out-report tools/grocery-bot/out/oracle-script-compression-report.json
node tools/grocery-bot/diff-replay-transition.mjs --source-replay tools/grocery-bot/out/<source-run>/replay.jsonl --validation-replay tools/grocery-bot/out/<validation-run>/replay.jsonl --tick 51

# Tests / viewer
node --test tools/grocery-bot/test/*.test.mjs
npm run grocery-bot:viewer
```

## Key File Map

```
tools/grocery-bot/
├── index.mjs                    Entry point, mode dispatch
├── src/
│   ├── planner.mjs              planSingleBot + GroceryPlanner class
│   ├── planner-singlebot.mjs    Single-bot evaluation, recovery, cooldowns
│   ├── planner-singlebot-runtime.mjs Single-bot runtime orchestration
│   ├── planner-multibot.mjs     Multi-bot task generation, costs, reservations
│   ├── planner-multibot-common.mjs Shared multi-bot demand/zone helpers
│   ├── planner-missions.mjs     Medium mission assignment and resolution
│   ├── planner-warehouse.mjs    Warehouse-control strategy (experimental)
│   ├── planner-multibot-runtime.mjs Multi-bot runtime execution
│   ├── planner-utils.mjs        Shared helpers (demand, phase, congestion)
│   ├── game-client.mjs          WebSocket loop, replay logging
│   ├── game-client-sanitizer.mjs Client-side legality sanitizer
│   ├── routing.mjs              Time-aware A* + path reservations
│   ├── assignment.mjs           Min-cost bot-to-item matching
│   ├── optimizer.mjs            Profile parameter search
│   ├── replay.mjs               Logging, summarize, simulate, analysis
│   ├── replay-io.mjs            Shared replay parsing/layout helpers
│   ├── replay-viewer.mjs        Run listing/loading for viewer
│   ├── oracle-script-optimizer.mjs Constraint-based oracle scheduler
│   ├── oracle-script-evaluator.mjs Deterministic validator/score estimator
│   ├── oracle-script-io.mjs     Oracle/script file loading
│   ├── world-model.mjs          Demand/inventory helpers
│   ├── coords.mjs               Grid geometry, move encoding
│   ├── grid-graph.mjs           Graph for pathfinding
│   ├── protocol.mjs             WebSocket message parsing
│   ├── profile.mjs              Profile loading + merging
│   └── cli.mjs                  Argument parsing
├── config/
│   ├── profiles.json            Tunable parameters per difficulty
│   ├── oracle-expert.json       Known expert orders/items
│   └── script-expert.json       Generated expert script
├── out/                         Replay data + tuned params
└── test/                        Node --test unit tests
```

## Architecture

**Critical constraint:** One unified action payload per tick covering all bots. All coordination is centralized in the planner.

**Single-bot (easy):** Enumerate candidate pickup-type sequences → score by (delivery points − route cost − leftover penalty) → execute best. Recovery on stagnation.

**Multi-bot (medium/hard/expert):** Build world context → cost-matrix assignment → time-aware A* with path reservations → deadlock detection → send all actions.

- `assignment_v1` is the live default for all difficulties except nightmare
- `warehouse_v1` is experimental, behind flag, not promoted until it beats 115 on medium
- Multiple drop zones supported via `drop_offs`

**Key parameters** (`config/profiles.json`): `assignment.congestion_penalty` / `contention_penalty` / `urgency_bonus`, `routing.horizon`, `anti_deadlock.stall_threshold` / `forced_wait_rounds`, `recovery.*`

## Development Workflow

1. Read `out/<run-id>/analysis.json` first
2. Use **replay-analyzer** subagent for deep digs
3. Use supported commands: `--mode runs`, `--mode analyze`, `--mode script-info`
4. Read the relevant planner module (not all of planner.mjs)
5. Make targeted change → run tests → simulate offline → play live → tune if improved

Oracle/script workflow: extract oracle → generate/optimize/compress script → inspect with `script-info` → play live with `--script` + `--oracle` → update oracle after run.

Run provenance: every live run records commit, dirty state, profile/oracle/script hashes in `summary.json` and `replay.jsonl`.

## Structural Policy

- `300+` lines: ask if change belongs in a narrower module
- `500+` lines: shrink in same change or record split plan in `STRUCTURE_REVIEW.md`
- Current structure map in `tools/grocery-bot/STRUCTURE_REVIEW.md`

## Specs And Experiments

- Every experiment needs specs + an entry in `tools/grocery-bot/EXPERIMENT_LOG.md`
- Update tests before spending live tokens unless behavior is already covered

## Active Improvement Backlog

Full analysis in `tools/grocery-bot/STRATEGY_REVIEW.md`. Priority order:
1. Freeze easy 118 baseline
2. Push expert past 89
3. Keep `assignment_v1` as active expert path
4. Use supported inspection commands
5. Rebuild same-day oracle/script on 89-point baseline

## Next Session

Resume from `tools/grocery-bot/NEXT_SESSION_PROMPT.md`.

## Conventions

- `.mjs` (ESM), no transpilation, no build step
- No external npm dependencies — pure Node.js stdlib + native WebSocket
- `node --test` for tests
- Profiles are plain JSON — tuned outputs in `out/`, merge manually after validation
- Never delete replay files
- Keep `STRATEGY_REVIEW.md` updated after significant runs
