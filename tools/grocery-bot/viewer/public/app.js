const state = {
  runs: [],
  selectedRunPath: null,
  runData: null,
  currentTickIndex: 0,
  playing: false,
  timer: null,
  markers: null,
};

const elements = {
  difficultyFilter: document.querySelector('#difficulty-filter'),
  profileFilter: document.querySelector('#profile-filter'),
  refreshRuns: document.querySelector('#refresh-runs'),
  runList: document.querySelector('#run-list'),
  runHeader: document.querySelector('#run-header'),
  playToggle: document.querySelector('#play-toggle'),
  prevTick: document.querySelector('#prev-tick'),
  nextTick: document.querySelector('#next-tick'),
  tickSlider: document.querySelector('#tick-slider'),
  tickLabel: document.querySelector('#tick-label'),
  board: document.querySelector('#board'),
  summaryView: document.querySelector('#summary-view'),
  tickView: document.querySelector('#tick-view'),
  plannerView: document.querySelector('#planner-view'),
  ordersView: document.querySelector('#orders-view'),
  botsView: document.querySelector('#bots-view'),
  jumpButtons: [...document.querySelectorAll('[data-jump]')],
};

function formatJson(value) {
  return JSON.stringify(value, null, 2);
}

function stopPlayback() {
  if (state.timer) {
    window.clearInterval(state.timer);
    state.timer = null;
  }
  state.playing = false;
  elements.playToggle.textContent = 'Play';
}

function buildMarkers(runData) {
  const ticks = runData?.ticks || [];
  const markers = {
    score: [],
    pickup: [],
    override: [],
    mode: [],
    stagnation: (runData?.analysis?.stagnationWindows || []).map((window) => window.startTick),
  };

  let previousScore = null;
  let previousMode = null;
  for (const tick of ticks) {
    const score = tick.state_snapshot?.score ?? 0;
    const mode = tick.planner_metrics?.controlMode ?? null;
    if (previousScore !== null && score > previousScore) {
      markers.score.push(tick.tick);
    }
    if ((tick.pickup_result || []).some((result) => result.succeeded === false)) {
      markers.pickup.push(tick.tick);
    }
    if ((tick.sanitizer_overrides || []).length > 0) {
      markers.override.push(tick.tick);
    }
    if (previousMode !== null && mode && mode !== previousMode) {
      markers.mode.push(tick.tick);
    }

    previousScore = score;
    if (mode) {
      previousMode = mode;
    }
  }

  return markers;
}

function findNextMarker(type) {
  const values = state.markers?.[type] || [];
  return values.find((tick) => tick > state.currentTickIndex) ?? values[0] ?? null;
}

function renderBoard(snapshot, layout, plannerMetrics) {
  elements.board.innerHTML = '';
  if (!layout?.grid) {
    return;
  }

  const width = layout.grid.width;
  const height = layout.grid.height;
  elements.board.style.gridTemplateColumns = `repeat(${width}, 28px)`;

  const walls = new Set((layout.grid.walls || []).map(([x, y]) => `${x},${y}`));
  const drops = new Set((layout.drop_offs || []).map(([x, y]) => `${x},${y}`));
  const itemsByCell = new Map();
  for (const item of snapshot?.items || []) {
    itemsByCell.set(`${item.position[0]},${item.position[1]}`, item);
  }

  const botsByCell = new Map();
  for (const bot of snapshot?.bots || []) {
    const key = `${bot.position[0]},${bot.position[1]}`;
    const entry = botsByCell.get(key) || [];
    entry.push(bot);
    botsByCell.set(key, entry);
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const key = `${x},${y}`;
      const cell = document.createElement('div');
      cell.className = 'cell';
      if (walls.has(key)) {
        cell.classList.add('wall');
      } else if (drops.has(key)) {
        cell.classList.add('drop');
      }

      const item = itemsByCell.get(key);
      if (item) {
        const itemEl = document.createElement('div');
        itemEl.className = 'item';
        itemEl.textContent = item.type.slice(0, 2);
        cell.appendChild(itemEl);
      }

      const bots = botsByCell.get(key) || [];
      if (bots.length > 0) {
        const botEl = document.createElement('div');
        botEl.className = 'bot';
        botEl.textContent = bots.map((bot) => {
          const mission = plannerMetrics?.missionTypeByBot?.[bot.id] || plannerMetrics?.missionTypeByBot?.[`${bot.id}`];
          return mission ? `${bot.id}:${mission.replace(/_.*/, '')}` : `${bot.id}`;
        }).join('|');
        cell.appendChild(botEl);
        if (bots.length > 1) {
          const stackEl = document.createElement('div');
          stackEl.className = 'stack';
          stackEl.textContent = `x${bots.length}`;
          cell.appendChild(stackEl);
        }
      }

      elements.board.appendChild(cell);
    }
  }
}

function renderTick() {
  const ticks = state.runData?.ticks || [];
  const tick = ticks[state.currentTickIndex];
  if (!tick) {
    return;
  }

  elements.tickSlider.value = String(state.currentTickIndex);
  elements.tickLabel.textContent = `${tick.tick} / ${ticks.at(-1)?.tick ?? 0}`;
  elements.runHeader.textContent = `${state.runData.run.runId} | ${state.runData.summary.finalScore ?? '?'} pts`;

  renderBoard(tick.state_snapshot, state.runData.layout, tick.planner_metrics || {});

  elements.summaryView.textContent = formatJson({
    difficulty: state.runData.summary.difficulty ?? state.runData.run.difficulty,
    profile: state.runData.summary.profile ?? state.runData.run.profile,
    finalScore: state.runData.summary.finalScore,
    ordersCompleted: state.runData.summary.finalOrders ?? state.runData.summary.metrics?.ordersCompleted,
    itemsDelivered: state.runData.summary.finalItems ?? state.runData.summary.metrics?.itemsDelivered,
    waits: state.runData.analysis?.actionEfficiency?.waitActions ?? null,
    stalls: state.runData.analysis?.multiBotCoordination?.totalStalls ?? null,
  });
  elements.tickView.textContent = formatJson({
    tick: tick.tick,
    score: tick.state_snapshot?.score,
    actions: tick.actions_sent,
    failedPickups: tick.pickup_result?.filter((result) => result.succeeded === false) || [],
    overrides: tick.sanitizer_overrides || [],
  });
  elements.plannerView.textContent = formatJson(tick.planner_metrics || {});
  elements.ordersView.textContent = formatJson(tick.state_snapshot?.orders || []);
  elements.botsView.textContent = formatJson((tick.state_snapshot?.bots || []).map((bot) => ({
    id: bot.id,
    position: bot.position,
    inventory: bot.inventory,
    mission: tick.planner_metrics?.missionTypeByBot?.[bot.id] || tick.planner_metrics?.missionTypeByBot?.[`${bot.id}`] || null,
  })));
}

async function loadRuns() {
  const params = new URLSearchParams();
  if (elements.difficultyFilter.value) {
    params.set('difficulty', elements.difficultyFilter.value);
  }
  if (elements.profileFilter.value.trim()) {
    params.set('profile', elements.profileFilter.value.trim());
  }

  const response = await fetch(`/api/runs?${params.toString()}`);
  const payload = await response.json();
  state.runs = payload.runs || [];
  renderRunList();
}

function renderRunList() {
  elements.runList.innerHTML = '';
  for (const run of state.runs) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `run-card${state.selectedRunPath === run.relativePath ? ' active' : ''}`;
    card.innerHTML = `
      <strong>${run.runId}</strong>
      <div>${run.difficulty || 'unknown'} | ${run.profile || 'unknown'}</div>
      <div>score ${run.finalScore ?? '?'} | orders ${run.finalOrders ?? '?'} | items ${run.finalItems ?? '?'}</div>
      <div>stalls ${run.totalStalls ?? '?'} | updated ${run.modifiedAt}</div>
    `;
    card.addEventListener('click', () => openRun(run.relativePath));
    elements.runList.appendChild(card);
  }
}

async function openRun(relativePath) {
  stopPlayback();
  state.selectedRunPath = relativePath;
  const response = await fetch(`/api/run?path=${encodeURIComponent(relativePath)}`);
  const payload = await response.json();
  state.runData = payload;
  state.currentTickIndex = 0;
  state.markers = buildMarkers(payload);

  const tickCount = payload.ticks.length;
  elements.playToggle.disabled = tickCount === 0;
  elements.prevTick.disabled = tickCount === 0;
  elements.nextTick.disabled = tickCount === 0;
  elements.tickSlider.disabled = tickCount === 0;
  elements.tickSlider.max = String(Math.max(0, tickCount - 1));
  renderRunList();
  renderTick();
}

function stepTick(delta) {
  const ticks = state.runData?.ticks || [];
  if (ticks.length === 0) {
    return;
  }

  state.currentTickIndex = Math.max(0, Math.min(ticks.length - 1, state.currentTickIndex + delta));
  renderTick();
}

function togglePlayback() {
  if (!state.runData?.ticks?.length) {
    return;
  }

  if (state.playing) {
    stopPlayback();
    return;
  }

  state.playing = true;
  elements.playToggle.textContent = 'Pause';
  state.timer = window.setInterval(() => {
    if (state.currentTickIndex >= state.runData.ticks.length - 1) {
      stopPlayback();
      return;
    }
    stepTick(1);
  }, 200);
}

elements.refreshRuns.addEventListener('click', () => loadRuns());
elements.playToggle.addEventListener('click', () => togglePlayback());
elements.prevTick.addEventListener('click', () => {
  stopPlayback();
  stepTick(-1);
});
elements.nextTick.addEventListener('click', () => {
  stopPlayback();
  stepTick(1);
});
elements.tickSlider.addEventListener('input', (event) => {
  stopPlayback();
  state.currentTickIndex = Number(event.target.value);
  renderTick();
});
for (const button of elements.jumpButtons) {
  button.addEventListener('click', () => {
    stopPlayback();
    const next = findNextMarker(button.dataset.jump);
    if (next !== null) {
      state.currentTickIndex = next;
      renderTick();
    }
  });
}

loadRuns().catch((error) => {
  elements.runHeader.textContent = `Failed to load runs: ${error.message}`;
});
