import path from 'node:path';

import { compareGeneratedScripts } from './oracle-script-search.mjs';

export function buildOptimizationJobs({
  runs = 8,
  seed = 7004,
  objectives = ['live_worthy'],
  strategy = 'auto',
  iterations = 150,
}) {
  const jobs = [];
  const normalizedObjectives = objectives.length > 0 ? objectives : ['handoff_value'];
  for (let index = 0; index < runs; index += 1) {
    jobs.push({
      id: index,
      seed: seed + index,
      objective: normalizedObjectives[index % normalizedObjectives.length],
      strategy,
      iterations,
    });
  }
  return jobs;
}

export function compareOptimizationResults(left, right, objective = 'handoff_value') {
  return compareGeneratedScripts(left.script, right.script, objective);
}

export function buildBatchReport({
  oraclePath,
  replayPath,
  objective,
  parallel,
  jobs,
  results,
  elapsedMs,
}) {
  const sorted = [...results].sort((left, right) => compareOptimizationResults(left, right, objective));
  const best = sorted[0] || null;
  const bestByObjective = [...new Set(results.map((result) => result.job.objective))].map((resultObjective) => {
    const ranked = [...results]
      .filter((result) => result.job.objective === resultObjective)
      .sort((left, right) => compareOptimizationResults(left, right, resultObjective));
    const top = ranked[0];
    return top ? {
      objective: resultObjective,
      id: top.job.id,
      seed: top.job.seed,
      strategy: top.script.strategy,
      estimated_score: top.script.estimated_score,
      last_scripted_tick: top.script.last_scripted_tick,
    } : null;
  }).filter(Boolean);
  return {
    generated_at: new Date().toISOString(),
    oracle_source: oraclePath,
    replay: replayPath,
    objective,
    parallel,
    jobs_requested: jobs.length,
    jobs_completed: results.length,
    elapsed_ms: elapsedMs,
    best_job: best ? {
      id: best.job.id,
      seed: best.job.seed,
      objective: best.job.objective,
      strategy: best.script.strategy,
      estimated_score: best.script.estimated_score,
      last_scripted_tick: best.script.last_scripted_tick,
      out_script: best.paths.outScript,
      out_report: best.paths.outReport,
    } : null,
    best_by_objective: bestByObjective,
    top_results: sorted.slice(0, 20).map((result, index) => ({
      rank: index + 1,
      id: result.job.id,
      seed: result.job.seed,
      objective: result.job.objective,
      strategy: result.script.strategy,
      estimated_score: result.script.estimated_score,
      last_scripted_tick: result.script.last_scripted_tick,
      total_waits: result.script.aggregate_efficiency?.total_waits || 0,
      out_script: path.basename(result.paths.outScript),
      out_report: path.basename(result.paths.outReport),
    })),
  };
}
