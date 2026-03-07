# Oracle Script Optimizer — Implementation Plan

## Goal
Generate a precomputed action script (`config/script-expert.json`) that completes all 11 known expert orders in as few ticks as possible, leaving maximum remaining ticks for the live planner to discover and complete new orders.

## Current State
- **Live run baseline**: score=91, 9 orders in 292 ticks (8 ticks wasted at end)
- **Optimizer v1** (single-item delivery): 8 orders in ~291 ticks, score=82
- **Optimizer v2** (batched delivery): 7 orders in ~264 ticks, score=74 (worse — batching causes idle time)
- **Root cause**: the optimizer is SLOWER than the live planner for mid/late orders because:
  1. Bot assignment is greedy (nearest task) not globally optimal
  2. Shelf selection doesn't account for future order needs (scarce items like oats/bread get consumed early)
  3. No pipelining — bots don't pre-pick next order items while current order is being delivered

## Key Findings
- **Bot idle time in live run**: only 4-11% idle after tick 50. Bots are busy, just not efficient.
- **Delivery batching hurts with 10 bots**: filling 3 items per bot trip wastes time; better to have many bots each carry 1-2 items in parallel.
- **Scarce items**: oats=5 shelves/5 needed, bread=5/5. Must be allocated carefully across orders.
- **Order timing**: orders appear at fixed ticks (tick 0, 62, 88, 102, 136, 164, 182, 225, 268, 292). The game only shows active+preview at any time, but oracle knows all.
- **Grid**: 28x18, drop-off at [1,16], bots start at [26,16]. Manhattan distance ~25 to drop-off from far shelves.

## Architecture (files already in place)
- `generate-script.mjs` — the optimizer (needs rewrite)
- `config/oracle-expert.json` — 11 known orders with item positions
- `config/script-expert.json` — output script consumed by planner
- `src/planner.mjs` — script replay integration (working, tested)
- `src/cli.mjs` — `--oracle` and `--script` flags (working)

## Recommended Approach: Constraint-Based Scheduler

Instead of tick-by-tick simulation with greedy decisions, plan at the ORDER level:

### Phase 1: Global Shelf Allocation
For each of the 11 orders, determine which specific shelf (item_id) supplies each required item type. Minimize total travel by:
- For each order, prefer shelves closest to drop-off
- For scarce types (oats, bread), reserve the closest shelves for the earliest orders
- This is a one-time static allocation done before simulation

### Phase 2: Order-Level Bot Assignment
For each order, assign bots to shelves:
- Each bot gets 1-2 shelves (pick then deliver) — don't try 3, too slow with 10 bots
- Assign bots currently nearest to the shelf positions
- Key: while order N is being delivered (bots heading to drop-off), assign idle bots to start picking order N+1 items. This is the PIPELINE.
- With 10 bots and orders of 4-6 items, ~4-6 bots work on current order, 4-6 pre-pick next order

### Phase 3: Time-Aware Multi-Bot Path Planning
For each order's assigned bots, compute collision-free paths using the existing `findPath` with reservations:
1. Route pick-bots to their assigned shelf adjacency
2. Pick up (1 tick)
3. Route to drop-off
4. Drop off (1 tick)
- CRITICAL: stagger drop-off arrivals — only 1 bot can occupy [1,16] per tick. Route them to arrive 1-2 ticks apart.
- Reserve the paths in the reservation table to avoid collisions between orders

### Phase 4: Tick-by-Tick Script Generation
Convert the per-order plans into per-tick action arrays. Fill any gaps with 'wait'.

## Implementation Priorities
1. **Fix shelf allocation** — allocate all 11 orders' shelves upfront, respecting scarcity
2. **Implement pipelining** — overlap pickup of order N+1 with delivery of order N
3. **Stagger drop-offs** — prevent all bots arriving at [1,16] at same tick
4. **Tune batch size** — test 1 vs 2 items per bot trip, likely 1-2 is optimal with 10 bots

## Success Metric
- Complete all 11 known orders by tick ~200 (leaving 100 ticks for live planner)
- Current best: 9 orders in 292 ticks (live) or 8 orders in 291 ticks (optimizer)
- Target: 11 orders by tick 200, which would give score ~115 from script alone + live planner gains

## Files to Modify
- `generate-script.mjs` — complete rewrite with constraint-based approach
- No other files need changes — planner integration is complete and tested

## Test Command
```bash
# Generate optimized script
node tools/grocery-bot/generate-script.mjs \
  --oracle tools/grocery-bot/config/oracle-expert.json \
  --replay tools/grocery-bot/out/2026-03-07T20-37-02-748Z-expert-expert/replay.jsonl \
  --out tools/grocery-bot/config/script-expert.json

# Play live with script
node tools/grocery-bot/index.mjs --token $TOKEN --difficulty expert --profile expert \
  --script tools/grocery-bot/config/script-expert.json \
  --oracle tools/grocery-bot/config/oracle-expert.json

# After run, update oracle
node tools/grocery-bot/tmp-extract-oracle.mjs
```
