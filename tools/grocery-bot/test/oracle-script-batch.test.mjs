import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildBatchReport,
  buildOptimizationJobs,
  compareOptimizationResults,
} from '../src/oracle-script-batch.mjs';

test('buildOptimizationJobs cycles objectives across seeds', () => {
  const jobs = buildOptimizationJobs({
    runs: 4,
    seed: 10,
    objectives: ['handoff_value', 'handoff_first'],
    strategy: 'auto',
    iterations: 50,
  });

  assert.equal(jobs.length, 4);
  assert.deepEqual(jobs.map((job) => job.seed), [10, 11, 12, 13]);
  assert.deepEqual(jobs.map((job) => job.objective), ['handoff_value', 'handoff_first', 'handoff_value', 'handoff_first']);
});

test('compareOptimizationResults delegates to script ranking', () => {
  const left = {
    script: { estimated_score: 60, last_scripted_tick: 200, orders_covered: 0, aggregate_efficiency: { total_waits: 50 } },
  };
  const right = {
    script: { estimated_score: 80, last_scripted_tick: 260, orders_covered: 0, aggregate_efficiency: { total_waits: 70 } },
  };

  assert.equal(compareOptimizationResults(left, right, 'handoff_value') > 0, true);
});

test('buildBatchReport orders top results by objective', () => {
  const report = buildBatchReport({
    oraclePath: '/tmp/oracle.json',
    replayPath: '/tmp/replay.jsonl',
    objective: 'handoff_value',
    parallel: 2,
    jobs: [{ id: 0 }, { id: 1 }],
    elapsedMs: 100,
    results: [
      {
        job: { id: 0, seed: 1, objective: 'handoff_value' },
        script: { strategy: 'modular', estimated_score: 20, last_scripted_tick: 180, orders_covered: 2, aggregate_efficiency: { total_waits: 100 } },
        paths: { outScript: '/tmp/a.json', outReport: '/tmp/a-report.json' },
      },
      {
        job: { id: 1, seed: 2, objective: 'handoff_value' },
        script: { strategy: 'replay_seeded_preserve', estimated_score: 80, last_scripted_tick: 260, orders_covered: 0, aggregate_efficiency: { total_waits: 800 } },
        paths: { outScript: '/tmp/b.json', outReport: '/tmp/b-report.json' },
      },
    ],
  });

  assert.equal(report.best_job.id, 1);
  assert.equal(report.top_results[0].strategy, 'replay_seeded_preserve');
  assert.equal(report.best_by_objective.length, 1);
  assert.equal(report.best_by_objective[0].objective, 'handoff_value');
});
