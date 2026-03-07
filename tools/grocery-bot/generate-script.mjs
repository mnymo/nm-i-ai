#!/usr/bin/env node
/**
 * Offline script optimizer for expert oracle mode.
 *
 * Plans multi-bot routes with batched pickups — each bot picks 2-3 items
 * before delivering, and orders are pipelined so idle bots pre-fetch next order.
 */

import fs from 'fs';
import { GridGraph } from './src/grid-graph.mjs';
import { encodeCoord, manhattanDistance, moveToAction } from './src/coords.mjs';

function parseArgs() {
  const args = { oracle: null, out: null, replay: null };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--oracle') args.oracle = argv[++i];
    if (argv[i] === '--out') args.out = argv[++i];
    if (argv[i] === '--replay') args.replay = argv[++i];
  }
  if (!args.oracle) throw new Error('--oracle required');
  if (!args.out) throw new Error('--out required');
  return args;
}

function buildGrid(oracle, replay) {
  if (replay) {
    try {
      const firstLine = fs.readFileSync(replay, 'utf8').split('\n')[0];
      const layout = JSON.parse(firstLine);
      if (layout.grid?.walls) return new GridGraph(layout.grid);
    } catch { /* fall through */ }
  }
  const w = oracle.grid.width, h = oracle.grid.height;
  const walls = [];
  for (let x = 0; x < w; x++) { walls.push([x, 0]); walls.push([x, h - 1]); }
  for (let y = 1; y < h - 1; y++) { walls.push([0, y]); walls.push([w - 1, y]); }
  for (const sx of [2, 6, 10, 14, 18, 22]) {
    for (let y = 2; y <= 8; y++) walls.push([sx, y]);
    for (let y = 10; y <= 14; y++) walls.push([sx, y]);
  }
  return new GridGraph({ width: w, height: h, walls });
}

function findPath(graph, start, goals, startTime, reservations, horizon = 60) {
  const goalSet = new Set(goals.map(g => encodeCoord(g)));
  if (goalSet.has(encodeCoord(start))) return [start];
  function h(pos) { let m = Infinity; for (const g of goals) { const d = manhattanDistance(pos, g); if (d < m) m = d; } return m; }
  const open = [{ coord: start, time: startTime, g: 0, f: h(start), parent: null }];
  const best = new Map([[`${encodeCoord(start)}@${startTime}`, 0]]);
  while (open.length > 0) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) { if (open[i].f < open[bi].f || (open[i].f === open[bi].f && open[i].g > open[bi].g)) bi = i; }
    const cur = open[bi]; open[bi] = open[open.length - 1]; open.pop();
    if (goalSet.has(encodeCoord(cur.coord))) {
      const path = []; let n = cur; while (n) { path.push(n.coord); n = n.parent; } return path.reverse();
    }
    if (cur.g >= horizon) continue;
    const nt = cur.time + 1;
    for (const next of [cur.coord, ...graph.neighbors(cur.coord)]) {
      const nk = encodeCoord(next);
      if (reservations.has(nt) && reservations.get(nt).has(nk)) continue;
      const ng = cur.g + 1, sk = `${nk}@${nt}`;
      if ((best.get(sk) ?? Infinity) <= ng) continue;
      best.set(sk, ng);
      open.push({ coord: next, time: nt, g: ng, f: ng + h(next), parent: cur });
    }
  }
  return null;
}

function reserveSlots(path, startTime, reservations, hold = 5) {
  for (let i = 0; i < path.length; i++) {
    const t = startTime + i, k = encodeCoord(path[i]);
    if (!reservations.has(t)) reservations.set(t, new Set());
    reservations.get(t).add(k);
  }
  const gk = encodeCoord(path[path.length - 1]), end = startTime + path.length - 1;
  for (let dt = 1; dt <= hold; dt++) { const t = end + dt; if (!reservations.has(t)) reservations.set(t, new Set()); reservations.get(t).add(gk); }
}

function main() {
  const args = parseArgs();
  const oracle = JSON.parse(fs.readFileSync(args.oracle, 'utf8'));
  const graph = buildGrid(oracle, args.replay);
  const dropOff = oracle.drop_off;
  const dropOffKey = encodeCoord(dropOff);
  const botCount = oracle.bot_count;

  const itemsByType = new Map();
  for (const item of oracle.items) {
    const list = itemsByType.get(item.type) || [];
    list.push(item);
    itemsByType.set(item.type, list);
  }
  for (const [, list] of itemsByType)
    list.sort((a, b) => manhattanDistance(a.position, dropOff) - manhattanDistance(b.position, dropOff));

  // ── State ──
  const bots = Array.from({ length: botCount }, (_, i) => ({
    id: i, pos: [26, 16], inventory: [],
    pickQueue: [],   // shelves to pick (up to 3), executed in order
    delivering: false,
    path: null,
  }));
  const usedShelves = new Set();
  const reservations = new Map();
  const script = [];

  let score = 0, ordersCompleted = 0, currentOrderIdx = 0;
  let delivered = [];  // types delivered for current active order

  function remainingDemand(orderIdx = currentOrderIdx) {
    if (orderIdx >= oracle.known_orders.length) return new Map();
    const order = oracle.known_orders[orderIdx];
    const need = new Map();
    for (const t of order.items_required) need.set(t, (need.get(t) || 0) + 1);
    if (orderIdx === currentOrderIdx) {
      for (const t of delivered) { if (need.has(t) && need.get(t) > 0) need.set(t, need.get(t) - 1); }
    }
    return need;
  }

  function totalMap(m) { let s = 0; for (const v of m.values()) s += v; return s; }

  function findShelf(type) {
    for (const item of (itemsByType.get(type) || [])) {
      if (!usedShelves.has(item.id)) return item;
    }
    return null;
  }

  // Plan pickup assignments: group items into bot loads of up to 3
  function planPickupBatches(orderIdx, priority) {
    if (orderIdx >= oracle.known_orders.length) return [];
    const need = remainingDemand(orderIdx);

    // Subtract items already assigned (in bot pickQueues or inventory) for this order
    for (const bot of bots) {
      for (const pq of bot.pickQueue) {
        if (pq.targetOrderIdx === orderIdx) {
          const t = pq.itemType;
          if (need.has(t) && need.get(t) > 0) need.set(t, need.get(t) - 1);
        }
      }
      // Items in inventory that will be delivered for this order
      if (orderIdx === currentOrderIdx) {
        for (const t of bot.inventory) {
          if (need.has(t) && need.get(t) > 0) need.set(t, need.get(t) - 1);
        }
      }
    }

    // Build shelf assignments
    const shelves = [];
    for (const [type, count] of need) {
      for (let i = 0; i < count; i++) {
        const shelf = findShelf(type);
        if (!shelf) continue;
        shelves.push({ shelfPos: shelf.position, itemId: shelf.id, itemType: type, priority, targetOrderIdx: orderIdx });
        usedShelves.add(shelf.id);
      }
    }
    return shelves;
  }

  // Assign shelves to bots greedily, batching up to 3 per bot
  function assignShelvesToBots(shelves) {
    // Sort shelves by distance to drop-off (pick close-to-dropoff items first for faster delivery)
    const sorted = [...shelves].sort((a, b) =>
      manhattanDistance(a.shelfPos, dropOff) - manhattanDistance(b.shelfPos, dropOff));

    // Group into batches of up to 3 nearby shelves
    const batches = [];
    const used = new Set();

    while (used.size < sorted.length) {
      // Find best unassigned bot (idle, closest to first unassigned shelf)
      const firstUnused = sorted.find((_, i) => !used.has(i));
      if (!firstUnused) break;
      const firstIdx = sorted.indexOf(firstUnused);

      let bestBot = null, bestDist = Infinity;
      for (const bot of bots) {
        if (bot.pickQueue.length > 0 || bot.delivering) continue;
        if (bot.inventory.length >= 3) continue;
        const d = manhattanDistance(bot.pos, firstUnused.shelfPos);
        if (d < bestDist) { bestDist = d; bestBot = bot; }
      }

      if (!bestBot) break; // no available bot

      const capacity = 3 - bestBot.inventory.length;
      const batch = [];

      // Pick up to `capacity` shelves, preferring nearby ones
      const remaining = sorted
        .map((s, i) => ({ ...s, idx: i }))
        .filter((_, i) => !used.has(i))
        .sort((a, b) => manhattanDistance(bestBot.pos, a.shelfPos) - manhattanDistance(bestBot.pos, b.shelfPos));

      for (const s of remaining) {
        if (batch.length >= capacity) break;
        batch.push(s);
        used.add(s.idx);
      }

      // Order batch for efficient routing: nearest first, then nearest to previous
      const ordered = [];
      let curPos = bestBot.pos;
      const batchCopy = [...batch];
      while (batchCopy.length > 0) {
        let bi = 0, bd = Infinity;
        for (let i = 0; i < batchCopy.length; i++) {
          const d = manhattanDistance(curPos, batchCopy[i].shelfPos);
          if (d < bd) { bd = d; bi = i; }
        }
        ordered.push(batchCopy.splice(bi, 1)[0]);
        curPos = ordered[ordered.length - 1].shelfPos;
      }

      bestBot.pickQueue = ordered;
    }
  }

  console.error(`Optimizing ${oracle.known_orders.length} orders, ${botCount} bots`);

  // Initial assignment for order 0
  let activeShelves = planPickupBatches(0, 'active');
  let nextShelves = planPickupBatches(1, 'next');
  assignShelvesToBots([...activeShelves, ...nextShelves]);
  activeShelves = []; nextShelves = []; // consumed by assignShelvesToBots

  console.error(`Order 0: ${oracle.known_orders[0].items_required.length} items`);

  for (let tick = 0; tick < 300; tick++) {
    for (const [t] of reservations) { if (t < tick) reservations.delete(t); }

    // Check order completion
    if (currentOrderIdx < oracle.known_orders.length) {
      const rd = remainingDemand();
      if (totalMap(rd) === 0) {
        score += 5;
        ordersCompleted++;
        const order = oracle.known_orders[currentOrderIdx];
        console.error(`  ORDER ${order.id} COMPLETE tick=${tick} (total ${score})`);
        currentOrderIdx++;
        delivered = [];

        // Reassign: promote 'next' pickQueues to 'active'
        for (const bot of bots) {
          for (const pq of bot.pickQueue) {
            if (pq.priority === 'next') pq.priority = 'active';
          }
        }

        // Plan new pickups for current + next
        const newActive = planPickupBatches(currentOrderIdx, 'active');
        const newNext = planPickupBatches(currentOrderIdx + 1, 'next');
        assignShelvesToBots([...newActive, ...newNext]);

        // Check completion again (in case items were pre-delivered)
        const rd2 = remainingDemand();
        if (totalMap(rd2) === 0 && currentOrderIdx < oracle.known_orders.length) {
          score += 5;
          ordersCompleted++;
          console.error(`  ORDER ${oracle.known_orders[currentOrderIdx].id} COMPLETE tick=${tick} (total ${score})`);
          currentOrderIdx++;
          delivered = [];
        }
      }
    }

    // Reassign idle bots
    const unassignedActive = planPickupBatches(currentOrderIdx, 'active');
    const unassignedNext = planPickupBatches(currentOrderIdx + 1, 'next');
    if (unassignedActive.length > 0 || unassignedNext.length > 0) {
      assignShelvesToBots([...unassignedActive, ...unassignedNext]);
    }

    // Handle bots that finished their pick queue → deliver
    for (const bot of bots) {
      if (bot.pickQueue.length === 0 && !bot.delivering && bot.inventory.length > 0) {
        bot.delivering = true;
        bot.path = null;
      }
    }

    // Compute paths
    for (const bot of bots) {
      if (bot.path && bot.path.length > 1) continue;

      if (bot.pickQueue.length > 0) {
        const target = bot.pickQueue[0];
        const adj = graph.neighbors(target.shelfPos);
        if (adj.some(c => encodeCoord(c) === encodeCoord(bot.pos))) {
          bot.path = [bot.pos]; // adjacent, ready to pick
        } else {
          const p = findPath(graph, bot.pos, adj, tick, reservations);
          if (p) { reserveSlots(p, tick, reservations, 3); bot.path = p; }
          else bot.path = [bot.pos];
        }
      } else if (bot.delivering) {
        if (encodeCoord(bot.pos) === dropOffKey) {
          bot.path = [bot.pos];
        } else {
          const p = findPath(graph, bot.pos, [dropOff], tick, reservations);
          if (p) { reserveSlots(p, tick, reservations, 2); bot.path = p; }
          else bot.path = [bot.pos];
        }
      }
    }

    // Execute actions
    const tickActions = [];
    for (const bot of bots) {
      let action = 'wait', itemId;

      if (bot.pickQueue.length > 0) {
        const target = bot.pickQueue[0];
        const adj = graph.neighbors(target.shelfPos);
        if (adj.some(c => encodeCoord(c) === encodeCoord(bot.pos))) {
          action = 'pick_up';
          itemId = target.itemId;
          bot.inventory.push(target.itemType);
          bot.pickQueue.shift();
          bot.path = null;
        } else if (bot.path && bot.path.length > 1) {
          action = moveToAction(bot.path[0], bot.path[1]);
          bot.pos = [...bot.path[1]];
          bot.path = bot.path.slice(1);
        }
      } else if (bot.delivering) {
        if (encodeCoord(bot.pos) === dropOffKey) {
          action = 'drop_off';
          if (currentOrderIdx < oracle.known_orders.length) {
            const rd = remainingDemand();
            for (const t of bot.inventory) {
              if ((rd.get(t) || 0) > 0) {
                delivered.push(t);
                rd.set(t, rd.get(t) - 1);
                score++;
              }
            }
          }
          bot.inventory = [];
          bot.delivering = false;
          bot.path = null;
        } else if (bot.path && bot.path.length > 1) {
          action = moveToAction(bot.path[0], bot.path[1]);
          bot.pos = [...bot.path[1]];
          bot.path = bot.path.slice(1);
        }
      }

      const entry = { bot: bot.id, action };
      if (itemId !== undefined) entry.item_id = itemId;
      tickActions.push(entry);
    }

    script.push({ tick, actions: tickActions });
  }

  // Stats
  let waits = 0, picks = 0, drops = 0;
  for (const s of script) for (const a of s.actions) {
    if (a.action === 'wait') waits++;
    else if (a.action === 'pick_up') picks++;
    else if (a.action === 'drop_off') drops++;
  }

  // Batch sizes
  const bpd = new Map(); const batches = [];
  for (const s of script) for (const a of s.actions) {
    if (a.action === 'pick_up') bpd.set(a.bot, (bpd.get(a.bot) || 0) + 1);
    if (a.action === 'drop_off') { batches.push(bpd.get(a.bot) || 0); bpd.set(a.bot, 0); }
  }

  console.error(`\nDone: ${ordersCompleted} orders, score ${score}`);
  console.error(`  Picks: ${picks}, Drops: ${drops}, Waits: ${waits}/${300*botCount} (${Math.round(waits/(300*botCount)*100)}% idle)`);
  console.error(`  Avg batch size: ${(batches.reduce((a,b)=>a+b,0)/batches.length).toFixed(1)} (${batches.filter(b=>b>=2).length} multi-item trips)`);

  const output = {
    description: `Optimized script for ${oracle.difficulty}`,
    bot_count: botCount, generated_at: new Date().toISOString(),
    last_scripted_tick: 299, orders_covered: ordersCompleted, estimated_score: score,
    ticks: script,
  };
  fs.writeFileSync(args.out, JSON.stringify(output, null, 2));
  console.error(`Script: ${args.out}`);
}

main();
