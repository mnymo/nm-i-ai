# Next Session Prompt

Initialize from `AGENTS.md`, `CLAUDE.md`, `.claude/settings.json`, and this file before doing any work.

Current starting point:
- New UTC-day expert baseline is `tools/grocery-bot/out/2026-03-08T00-03-58-975Z-expert-expert`
- Result: score `13`, `1` order, `8` items
- Key failure pattern: `373` sanitizer overrides, `1010` waits, `1306` stalls, dead zone from tick `101`

What changed recently:
- Replay/handoff tooling is instrumented and provenance-tagged
- `diff-replay-transition.mjs` exists for replay drift debugging
- `run-provenance.mjs` writes commit/profile/oracle/script hashes into `summary.json` and `replay.jsonl`
- `expert_replay_handoff` exists, but old-day replay/oracle assets are stale after UTC rollover

Do first:
1. Read:
   - `tools/grocery-bot/out/2026-03-08T00-03-58-975Z-expert-expert/analysis.json`
   - `tools/grocery-bot/out/2026-03-08T00-03-58-975Z-expert-expert/summary.json`
   - `tools/grocery-bot/STRATEGY_REVIEW.md`
   - `tools/grocery-bot/EXPERIMENT_LOG.md`
2. Rebuild `tools/grocery-bot/config/oracle-expert.json` for the new day before any new expert oracle/script attempts.
3. Focus on the live expert planner before hybrid mode:
   - reduce preview/non-deliverable hoarding
   - increase active-order completion/drop cadence
   - reduce stationary-occupant conflicts at 10 bots

Do not assume:
- old `oracle-expert.json` is valid
- old `script-expert.json` is valid
- old replay openings are reusable on the new day

Helpful references:
- Historical expert high score: `tools/grocery-bot/out/2026-03-07T20-37-02-748Z-expert-expert`
- Historical hybrid runs:
  - `tools/grocery-bot/out/2026-03-07T23-52-29-214Z-expert-expert_replay_handoff`
  - `tools/grocery-bot/out/2026-03-07T23-59-03-111Z-expert-expert_replay_handoff`

Initial objective for tomorrow:
- get expert above the new-day `13` baseline with planner-only improvements first
- only reintroduce oracle/script once the new-day expert planner is healthier
