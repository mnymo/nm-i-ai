import test from 'node:test';
import assert from 'node:assert/strict';

import { GroceryPlanner } from '../src/planner.mjs';
import { defaultProfiles } from '../src/profile.mjs';

function baseState(overrides = {}) {
  return {
    type: 'game_state',
    round: 0,
    max_rounds: 300,
    grid: { width: 6, height: 6, walls: [] },
    bots: [{ id: 0, position: [1, 1], inventory: [] }],
    items: [{ id: 'item_0', type: 'milk', position: [2, 1] }],
    orders: [{ id: 'o0', items_required: ['milk'], items_delivered: [], status: 'active', complete: false }],
    drop_off: [0, 0],
    score: 0,
    ...overrides,
  };
}

test('planner replays scripted tick verbatim and hands off to live planner afterward', () => {
  const planner = new GroceryPlanner(defaultProfiles.easy, {
    script: {
      tickMap: new Map([
        [0, [{ bot: 0, action: 'wait' }]],
      ]),
      entryMap: new Map([
        [0, { tick: 0, actions: [{ bot: 0, action: 'wait' }] }],
      ]),
    },
  });

  const scripted = planner.plan(baseState({ round: 0 }));
  assert.deepEqual(scripted, [{ bot: 0, action: 'wait' }]);
  assert.equal(planner.getLastMetrics().scripted, true);

  const live = planner.plan(baseState({ round: 1 }));
  assert.deepEqual(live, [{ bot: 0, action: 'pick_up', item_id: 'item_0' }]);
  assert.notEqual(planner.getLastMetrics().scripted, true);
});

test('planner trusts replay-derived scripted tick when expected state matches', () => {
  const state = baseState({ round: 0 });
  const planner = new GroceryPlanner(defaultProfiles.easy, {
    script: {
      tickMap: new Map([
        [0, [{ bot: 0, action: 'wait' }]],
      ]),
      entryMap: new Map([
        [0, {
          tick: 0,
          actions: [{ bot: 0, action: 'wait' }],
          expected_state: {
            score: 0,
            bots: [{ id: 0, position: [1, 1], inventory: [] }],
          },
        }],
      ]),
    },
  });

  const scripted = planner.plan(state);
  assert.deepEqual(scripted, [{ bot: 0, action: 'wait' }]);
  assert.equal(planner.getLastMetrics().scripted, true);
  assert.equal(planner.getLastMetrics().scriptTrusted, true);
  assert.equal(planner.getLastMetrics().scriptExpectedStateMatched, true);
});

test('planner disables script and falls back to live planning on expected-state divergence', () => {
  const planner = new GroceryPlanner(defaultProfiles.easy, {
    script: {
      tickMap: new Map([
        [0, [{ bot: 0, action: 'wait' }]],
        [1, [{ bot: 0, action: 'wait' }]],
      ]),
      entryMap: new Map([
        [0, {
          tick: 0,
          actions: [{ bot: 0, action: 'wait' }],
          expected_state: {
            score: 1,
            bots: [{ id: 0, position: [1, 1], inventory: [] }],
          },
        }],
        [1, {
          tick: 1,
          actions: [{ bot: 0, action: 'wait' }],
          expected_state: {
            score: 0,
            bots: [{ id: 0, position: [1, 1], inventory: [] }],
          },
        }],
      ]),
    },
  });

  const first = planner.plan(baseState({ round: 0 }));
  assert.deepEqual(first, [{ bot: 0, action: 'pick_up', item_id: 'item_0' }]);
  assert.equal(planner.getLastMetrics().scriptDiverged, true);
  assert.equal(planner.getLastMetrics().scriptDivergedAtRound, 0);

  const second = planner.plan(baseState({ round: 1 }));
  assert.notEqual(planner.getLastMetrics().scripted, true);
  assert.deepEqual(second, [{ bot: 0, action: 'pick_up', item_id: 'item_0' }]);
});
