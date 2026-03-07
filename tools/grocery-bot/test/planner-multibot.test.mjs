import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTasks, prioritizeBotsForPlanning } from '../src/planner-multibot.mjs';
import { defaultProfiles } from '../src/profile.mjs';
import { buildWorldContext } from '../src/world-model.mjs';

function baseState(overrides = {}) {
  return {
    type: 'game_state',
    round: 0,
    max_rounds: 300,
    grid: { width: 12, height: 10, walls: [] },
    bots: [
      { id: 0, position: [1, 1], inventory: [] },
      { id: 1, position: [3, 1], inventory: [] },
      { id: 2, position: [5, 1], inventory: [] },
    ],
    items: [],
    orders: [
      { id: 'o0', items_required: ['milk'], items_delivered: [], status: 'active', complete: false },
      { id: 'o1', items_required: ['pasta'], items_delivered: [], status: 'preview', complete: false },
    ],
    drop_off: [1, 8],
    score: 0,
    ...overrides,
  };
}

test('buildTasks does not create preview pickup tasks when preview demand is already covered by inventory', () => {
  const state = baseState({
    bots: [
      { id: 0, position: [1, 1], inventory: ['pasta', 'pasta', 'pasta'] },
      { id: 1, position: [3, 1], inventory: [] },
      { id: 2, position: [5, 1], inventory: [] },
    ],
    items: [
      { id: 'milk_0', type: 'milk', position: [3, 3] },
      { id: 'pasta_0', type: 'pasta', position: [5, 3] },
      { id: 'pasta_1', type: 'pasta', position: [7, 3] },
    ],
  });

  const tasks = buildTasks(state, buildWorldContext(state), defaultProfiles.medium, 'early');
  const pickupTypes = tasks.filter((task) => task.kind === 'pick_up').map((task) => task.item.type);

  assert.equal(pickupTypes.includes('pasta'), false);
  assert.equal(pickupTypes.includes('milk'), true);
});

test('buildTasks caps preview pickup candidates to remaining preview demand plus small buffer', () => {
  const state = baseState({
    bots: [
      { id: 0, position: [1, 1], inventory: ['milk'] },
      { id: 1, position: [3, 1], inventory: [] },
      { id: 2, position: [5, 1], inventory: [] },
    ],
    items: [
      { id: 'pasta_0', type: 'pasta', position: [3, 3] },
      { id: 'pasta_1', type: 'pasta', position: [5, 3] },
      { id: 'pasta_2', type: 'pasta', position: [7, 3] },
      { id: 'pasta_3', type: 'pasta', position: [9, 3] },
    ],
    orders: [
      { id: 'o0', items_required: ['milk'], items_delivered: [], status: 'active', complete: false },
      { id: 'o1', items_required: ['pasta'], items_delivered: [], status: 'preview', complete: false },
    ],
  });

  const tasks = buildTasks(state, buildWorldContext(state), defaultProfiles.medium, 'early');
  const pastaTasks = tasks.filter((task) => task.kind === 'pick_up' && task.item.type === 'pasta');

  assert.equal(pastaTasks.length <= 2, true);
});

test('prioritizeBotsForPlanning favors drop-off carriers before active pickups and preview pickups', () => {
  const state = baseState({
    bots: [
      { id: 0, position: [1, 1], inventory: ['milk', 'milk'] },
      { id: 1, position: [3, 1], inventory: [] },
      { id: 2, position: [5, 1], inventory: ['bread'] },
    ],
    orders: [
      { id: 'o0', items_required: ['milk', 'milk', 'bread'], items_delivered: [], status: 'active', complete: false },
      { id: 'o1', items_required: ['pasta'], items_delivered: [], status: 'preview', complete: false },
    ],
  });
  const world = buildWorldContext(state);
  const taskByBot = new Map([
    [0, { kind: 'drop_off', key: 'drop:0' }],
    [1, { kind: 'pick_up', key: 'item:pasta_0', sourceOrder: 'preview' }],
    [2, { kind: 'pick_up', key: 'item:bread_0', sourceOrder: 'active' }],
  ]);

  const prioritized = prioritizeBotsForPlanning(state, taskByBot, world.activeDemand).map((bot) => bot.id);

  assert.deepEqual(prioritized, [0, 2, 1]);
});
