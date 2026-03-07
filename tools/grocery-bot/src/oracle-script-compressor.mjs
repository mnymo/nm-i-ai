import { parseJsonl } from './replay-io.mjs';

function cloneTick(tick) {
  return {
    tick: tick.tick,
    actions: tick.actions.map((action) => ({ ...action })),
  };
}

function buildTickRows(replayPath) {
  return parseJsonl(replayPath).filter((row) => row.type === 'tick');
}

export function extractScriptFromReplay(replayPath, stopTick = null) {
  const tickRows = buildTickRows(replayPath);
  const ticks = [];

  for (const row of tickRows) {
    if (stopTick !== null && row.tick > stopTick) {
      break;
    }
    ticks.push({
      tick: row.tick,
      actions: (row.actions_sent || row.actions_planned || []).map((action) => ({ ...action })),
    });
  }

  return {
    ticks,
    last_scripted_tick: ticks.at(-1)?.tick ?? -1,
  };
}

function summarizeReplayProgress(tickRows) {
  const scoreTimeline = tickRows.map((row) => ({
    tick: row.tick,
    score: row.state_snapshot?.score ?? 0,
  }));
  const finalScore = scoreTimeline.at(-1)?.score ?? 0;
  return {
    scoreTimeline,
    finalScore,
  };
}

function earliestTickMeetingScore(scoreTimeline, targetScore) {
  const hit = scoreTimeline.find((entry) => entry.score >= targetScore);
  return hit?.tick ?? scoreTimeline.at(-1)?.tick ?? -1;
}

export function compressOracleReplayScript({
  oracle,
  replayPath,
  stopTick = null,
  targetOrdersCovered = null,
  targetScore = null,
}) {
  const tickRows = buildTickRows(replayPath);
  const { scoreTimeline, finalScore } = summarizeReplayProgress(tickRows);
  const requiredScore = targetScore ?? finalScore;
  const baselineLastTick = stopTick ?? (tickRows.at(-1)?.tick ?? -1);
  const scoreSeenTick = Math.min(
    baselineLastTick,
    earliestTickMeetingScore(scoreTimeline, requiredScore),
  );
  const targetTick = Math.max(0, scoreSeenTick - 1);

  const extracted = extractScriptFromReplay(replayPath, targetTick);

  return {
    description: `Compressed replay-derived script for ${oracle?.difficulty || 'unknown'}`,
    strategy: 'replay_rewind_v1',
    generated_at: new Date().toISOString(),
    oracle_source: null,
    orders_covered: targetOrdersCovered,
    estimated_score: requiredScore,
    last_scripted_tick: extracted.last_scripted_tick,
    cutoff_reason: 'replay_target_score_reached',
    per_order_estimates: [],
    aggregate_efficiency: {
      total_waits: extracted.ticks.flatMap((tick) => tick.actions).filter((action) => action.action === 'wait').length,
      total_picks: extracted.ticks.flatMap((tick) => tick.actions).filter((action) => action.action === 'pick_up').length,
      total_drops: extracted.ticks.flatMap((tick) => tick.actions).filter((action) => action.action === 'drop_off').length,
      average_items_per_trip: 0,
    },
    replay_target_meta: {
      source_replay: replayPath,
      baseline_score: finalScore,
      baseline_last_tick: baselineLastTick,
      target_score: requiredScore,
      target_tick: scoreSeenTick,
      script_cutoff_tick: targetTick,
      final_tick_delta: baselineLastTick - extracted.last_scripted_tick,
    },
    ticks: extracted.ticks.map(cloneTick),
  };
}
