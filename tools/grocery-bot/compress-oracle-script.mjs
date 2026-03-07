#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

import { compressOracleReplayScript } from './src/oracle-script-compressor.mjs';

function parseArgs(argv) {
  const args = {
    oracle: null,
    replay: null,
    outScript: null,
    outReport: null,
    stopTick: null,
    scoreToBeat: null,
    ordersToBeat: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === '--oracle') {
      args.oracle = value;
      index += 1;
    } else if (key === '--replay') {
      args.replay = value;
      index += 1;
    } else if (key === '--out-script') {
      args.outScript = value;
      index += 1;
    } else if (key === '--out-report') {
      args.outReport = value;
      index += 1;
    } else if (key === '--stop-tick') {
      args.stopTick = Number.parseInt(value, 10);
      index += 1;
    } else if (key === '--score-to-beat') {
      args.scoreToBeat = Number.parseInt(value, 10);
      index += 1;
    } else if (key === '--orders-to-beat') {
      args.ordersToBeat = Number.parseInt(value, 10);
      index += 1;
    }
  }

  if (!args.oracle) throw new Error('--oracle required');
  if (!args.replay) throw new Error('--replay required');
  if (!args.outScript) throw new Error('--out-script required');
  if (!args.outReport) throw new Error('--out-report required');

  return {
    oracle: path.resolve(process.cwd(), args.oracle),
    replay: path.resolve(process.cwd(), args.replay),
    outScript: path.resolve(process.cwd(), args.outScript),
    outReport: path.resolve(process.cwd(), args.outReport),
    stopTick: Number.isFinite(args.stopTick) ? args.stopTick : null,
    scoreToBeat: Number.isFinite(args.scoreToBeat) ? args.scoreToBeat : null,
    ordersToBeat: Number.isFinite(args.ordersToBeat) ? args.ordersToBeat : null,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const oracle = JSON.parse(fs.readFileSync(args.oracle, 'utf8'));
  const script = compressOracleReplayScript({
    oracle,
    replayPath: args.replay,
    stopTick: args.stopTick,
    targetOrdersCovered: args.ordersToBeat,
    targetScore: args.scoreToBeat,
  });

  script.oracle_source = args.oracle;

  const report = {
    generated_at: script.generated_at,
    replay: args.replay,
    oracle_source: args.oracle,
    strategy: script.strategy,
    baseline_score: script.replay_target_meta.baseline_score,
    baseline_last_tick: script.replay_target_meta.baseline_last_tick,
    final_score: script.estimated_score,
    final_last_tick: script.last_scripted_tick,
    target_score: script.replay_target_meta.target_score,
    target_tick: script.replay_target_meta.target_tick,
    score_at_script_end: script.replay_target_meta.score_at_script_end,
    final_tick_delta: script.replay_target_meta.final_tick_delta,
  };

  fs.writeFileSync(args.outScript, `${JSON.stringify(script, null, 2)}\n`);
  fs.writeFileSync(args.outReport, `${JSON.stringify(report, null, 2)}\n`);

  console.error(`Baseline: ${report.baseline_score} score / tick ${report.baseline_last_tick}`);
  console.error(`Compressed prefix: ${report.final_score} score / tick ${report.final_last_tick}`);
  console.error(`Replay target score/tick after handoff: ${report.target_score} / ${report.target_tick}`);
  console.error(`Tick delta: ${report.final_tick_delta}`);
  console.error(`Script: ${args.outScript}`);
  console.error(`Report: ${args.outReport}`);
}

main();
