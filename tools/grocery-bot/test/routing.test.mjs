import test from 'node:test';
import assert from 'node:assert/strict';

import { GridGraph } from '../src/grid-graph.mjs';
import { findTimeAwarePath, reservePath } from '../src/routing.mjs';

test('findTimeAwarePath returns a direct path when no reservations exist', () => {
  const graph = new GridGraph({ width: 4, height: 3, walls: [] });
  const reservations = new Map();

  const path = findTimeAwarePath({
    graph,
    start: [0, 0],
    goal: [2, 0],
    reservations,
    startTime: 0,
    horizon: 10,
  });

  assert.deepEqual(path, [
    [0, 0],
    [1, 0],
    [2, 0],
  ]);
});

test('findTimeAwarePath avoids reserved cells at reserved timesteps', () => {
  const graph = new GridGraph({ width: 4, height: 3, walls: [] });
  const reservations = new Map([[1, new Set(['1,0'])]]);

  const path = findTimeAwarePath({
    graph,
    start: [0, 0],
    goal: [2, 0],
    reservations,
    startTime: 0,
    horizon: 10,
  });

  assert.equal(path[0][0], 0);
  assert.equal(path[0][1], 0);
  assert.equal(path[path.length - 1][0], 2);
  assert.equal(path[path.length - 1][1], 0);
  assert.notDeepEqual(path[1], [1, 0]);
});

test('reservePath limits goal holds to the configured hold steps', () => {
  const reservations = new Map();
  const edgeReservations = new Map();

  reservePath({
    path: [
      [0, 0],
      [1, 0],
    ],
    startTime: 0,
    reservations,
    edgeReservations,
    horizon: 8,
    holdAtGoal: true,
    holdSteps: 2,
  });

  assert.equal(reservations.get(1)?.has('1,0'), true);
  assert.equal(reservations.get(2)?.has('1,0'), true);
  assert.equal(reservations.get(3)?.has('1,0'), true);
  assert.equal(reservations.get(4)?.has('1,0') || false, false);
});
