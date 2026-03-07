export function sumCounts(map) {
  return Array.from(map.values()).reduce((sum, count) => sum + Math.max(0, count), 0);
}

export function reserveInventoryForDemand(inventoryCounts, demand) {
  const remainingDemand = new Map(demand);
  const surplusInventory = new Map(inventoryCounts);

  for (const [type, count] of inventoryCounts.entries()) {
    const required = remainingDemand.get(type) || 0;
    if (required <= 0 || count <= 0) {
      continue;
    }

    const used = Math.min(count, required);
    remainingDemand.set(type, required - used);
    surplusInventory.set(type, count - used);
  }

  return { remainingDemand, surplusInventory };
}

export function zoneIndexForX(x, width, zoneCount) {
  if (zoneCount <= 1 || width <= 0) {
    return 0;
  }

  const normalized = Math.max(0, Math.min(width - 1, x));
  return Math.min(zoneCount - 1, Math.floor((normalized * zoneCount) / width));
}

export function zoneBounds(state, zoneId) {
  const zoneCount = Math.max(1, state.bots.length);
  const startX = Math.floor((zoneId * state.grid.width) / zoneCount);
  const nextStartX = Math.floor(((zoneId + 1) * state.grid.width) / zoneCount);
  return [startX, Math.max(startX, nextStartX - 1)];
}

export function zoneIdForBot(state, botId) {
  const botOrder = [...state.bots].sort((a, b) => a.id - b.id);
  return Math.max(0, botOrder.findIndex((candidate) => candidate.id === botId));
}

export function findZoneStagingCell(bot, state, graph, blockedCoords = null) {
  const zoneId = zoneIdForBot(state, bot.id);
  const [startX, endX] = zoneBounds(state, zoneId);
  const preferredY = Math.max(1, Math.min(state.grid.height - 2, state.drop_off[1]));
  const centerX = Math.max(startX, Math.min(endX, Math.floor((startX + endX) / 2)));

  let best = null;
  for (let y = 1; y < state.grid.height - 1; y += 1) {
    for (let x = startX; x <= endX; x += 1) {
      const candidate = [x, y];
      if (!graph.isWalkable(candidate)) {
        continue;
      }

      if (blockedCoords?.has(`${candidate[0]},${candidate[1]}`)) {
        continue;
      }

      const score = Math.abs(y - preferredY) * 2 + Math.abs(x - centerX) * 2;
      const travel = Math.abs(bot.position[0] - x) + Math.abs(bot.position[1] - y);
      const totalScore = score + travel;
      if (!best || totalScore < best.score) {
        best = { cell: candidate, score: totalScore };
      }
    }
  }

  return best?.cell || [...bot.position];
}

export function estimateZonePenalty({ bot, task, state, profile }) {
  if (task?.kind !== 'pick_up' || !task.item || state.bots.length <= 1) {
    return 0;
  }

  const botOrder = [...state.bots].sort((a, b) => a.id - b.id);
  const botIndex = botOrder.findIndex((candidate) => candidate.id === bot.id);
  if (botIndex < 0) {
    return 0;
  }

  const itemX = task.item.position?.[0];
  if (!Number.isFinite(itemX)) {
    return 0;
  }

  const taskZoneIndex = zoneIndexForX(itemX, state.grid.width, botOrder.length);
  const zoneDelta = Math.abs(taskZoneIndex - botIndex);
  if (zoneDelta === 0) {
    return 0;
  }

  const activePenalty = profile.assignment.active_zone_penalty ?? 0.35;
  const previewPenalty = profile.assignment.preview_zone_penalty ?? 1.1;
  const basePenalty = task.sourceOrder === 'preview' ? previewPenalty : activePenalty;

  return zoneDelta * basePenalty;
}
