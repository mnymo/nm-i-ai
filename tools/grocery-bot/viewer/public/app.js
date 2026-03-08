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
  // Emoji mapping based on CURRENT game specification (March 2026)
  // Current game item types from live replay: apples, eggs, flour, bananas, cheese, cream,
  // cereal, rice, pasta, oats, butter, bread, onions, milk, tomatoes, yogurt
  const ITEM_EMOJIS = {
    // Core items from current game (verified in replay data)
    apples: '🍎',     // plural form used in game
    eggs: '🥚',       // plural form used in game
    flour: '🌾',      // flour for baking
    bananas: '🍌',    // plural form used in game
    cheese: '🧀',     // cheese blocks
    cream: '🥛',      // heavy cream (different from milk)
    cereal: '🥣',     // breakfast cereal
    rice: '🍚',       // cooked rice
    pasta: '🍝',      // pasta noodles
    oats: '🌾',       // oat grains (using grain emoji)
    butter: '🧈',     // butter spread
    bread: '🍞',      // bread loaf  
    onions: '🧅',     // plural form used in game 
    milk: '🐮',       // milk carton
    tomatoes: '🍅',   // plural form used in game
    yogurt: '🍦',     // yogurt container
    
    // fallback for unknown types
    default: '🛒',
  };
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

  // Task type colors for bot visualization
  const TASK_COLORS = {
    item: '#2a9d8f',        // pickup - teal
    pick_up: '#2a9d8f',
    pickup_active: '#2a9d8f',
    pickup_preview: '#457b9d',
    drop_off: '#e76f51',    // delivery - orange-red
    drop_active: '#e76f51',
    parking: '#6c757d',     // idle - gray
    none: '#6c757d',
    single: '#2a9d8f',
    fallback: '#bc6c25',    // fallback - brown
    anti_deadlock: '#d62828', // deadlock - red
    warehouse_fallback: '#d62828',
    idle_reposition: '#6c757d',
    reposition_zone: '#6c757d',
    queue_service_bay: '#457b9d',
  };

  const botDetails = (plannerMetrics && plannerMetrics.botDetails) || {};

  // Cell size constant (must match CSS .cell width/height)
  const CELL_SIZE = 29; // 28px + 1px gap

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
        const typeKey = (item.type || '').toLowerCase();
        const emoji = ITEM_EMOJIS[typeKey] || ITEM_EMOJIS.default;
        const itemEl = document.createElement('div');
        itemEl.className = 'item';
        itemEl.textContent = emoji;
        cell.appendChild(itemEl);
      }

      const bots = botsByCell.get(key) || [];
      if (bots.length > 0) {
        const botEl = document.createElement('div');
        botEl.className = 'bot';
        const firstBotDetail = botDetails[bots[0]?.id];
        const taskType = firstBotDetail?.taskType || 'none';
        botEl.style.background = TASK_COLORS[taskType] || TASK_COLORS.none;
        botEl.textContent = bots.map((bot) => `${bot.id}`).join(' ');
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

  // SVG overlay for bot target lines and paths
  const svgWidth = width * CELL_SIZE;
  const svgHeight = height * CELL_SIZE;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', svgWidth);
  svg.setAttribute('height', svgHeight);
  svg.style.cssText = `position:absolute;top:8px;left:8px;pointer-events:none;z-index:10;`;

  for (const bot of snapshot?.bots || []) {
    const detail = botDetails[bot.id];
    if (!detail) continue;
    const color = TASK_COLORS[detail.taskType] || TASK_COLORS.none;
    const bx = bot.position[0] * CELL_SIZE + CELL_SIZE / 2;
    const by = bot.position[1] * CELL_SIZE + CELL_SIZE / 2;

    // Draw planned path as dotted line
    if (detail.path && detail.path.length > 1) {
      const points = detail.path.map((p) => `${p[0] * CELL_SIZE + CELL_SIZE / 2},${p[1] * CELL_SIZE + CELL_SIZE / 2}`).join(' ');
      const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      polyline.setAttribute('points', points);
      polyline.setAttribute('fill', 'none');
      polyline.setAttribute('stroke', color);
      polyline.setAttribute('stroke-width', '2');
      polyline.setAttribute('stroke-dasharray', '4,3');
      polyline.setAttribute('opacity', '0.6');
      svg.appendChild(polyline);
    }

    // Draw target indicator (circle at target)
    if (detail.target) {
      const tx = detail.target[0] * CELL_SIZE + CELL_SIZE / 2;
      const ty = detail.target[1] * CELL_SIZE + CELL_SIZE / 2;
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', tx);
      circle.setAttribute('cy', ty);
      circle.setAttribute('r', '5');
      circle.setAttribute('fill', 'none');
      circle.setAttribute('stroke', color);
      circle.setAttribute('stroke-width', '2');
      circle.setAttribute('opacity', '0.8');
      svg.appendChild(circle);

      // Direct line from bot to target (if no path)
      if (!detail.path || detail.path.length <= 1) {
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', bx);
        line.setAttribute('y1', by);
        line.setAttribute('x2', tx);
        line.setAttribute('y2', ty);
        line.setAttribute('stroke', color);
        line.setAttribute('stroke-width', '1.5');
        line.setAttribute('stroke-dasharray', '6,4');
        line.setAttribute('opacity', '0.4');
        svg.appendChild(line);
      }
    }

    // Bot ID label at bot position
    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', bx);
    label.setAttribute('y', by - 10);
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('font-size', '9');
    label.setAttribute('fill', color);
    label.setAttribute('font-weight', 'bold');
    label.textContent = `B${bot.id}`;
    svg.appendChild(label);
  }

  elements.board.appendChild(svg);
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
  // Render order boxes with active/assigned bots
  const orders = tick.state_snapshot?.orders || [];
  const bots = tick.state_snapshot?.bots || [];
  const botDetailsMap = tick.planner_metrics?.botDetails || {};
  const TASK_COLORS = {
    item: '#2a9d8f', pick_up: '#2a9d8f', pickup_active: '#2a9d8f', pickup_preview: '#457b9d',
    drop_off: '#e76f51', drop_active: '#e76f51',
    parking: '#6c757d', none: '#6c757d', single: '#2a9d8f',
    fallback: '#bc6c25', anti_deadlock: '#d62828', warehouse_fallback: '#d62828',
    idle_reposition: '#6c757d', reposition_zone: '#6c757d', queue_service_bay: '#457b9d',
  };
  const ITEM_EMOJIS = {
    apples: '🍎', eggs: '🥚', flour: '🌾', bananas: '🍌', cheese: '🧀', cream: '🥛',
    cereal: '🥣', rice: '🍚', pasta: '🍝', oats: '🌾', butter: '🧈', bread: '🍞',
    onions: '🧅', milk: '🐮', tomatoes: '🍅', yogurt: '🍦', default: '🛒',
  };
  elements.ordersView.innerHTML = orders.map((order) => {
    const isActive = order.status === 'active' && !order.complete;
    const requiredItems = order.items_required || [];
    const deliveredItems = order.items_delivered || [];
    const progress = deliveredItems.length;
    const total = requiredItems.length;
    return `<div style="border:1px solid #888;padding:4px;margin-bottom:2px;background:${isActive ? '#fffde7' : '#ececec'}">
      <b>Order ${order.id}</b> ${isActive ? '🟢' : '⚪'} (${progress}/${total})<br>
      Required: ${requiredItems.map((it) => (ITEM_EMOJIS[it] || ITEM_EMOJIS.default)).join(' ')}<br>
      Delivered: ${deliveredItems.map((it) => (ITEM_EMOJIS[it] || ITEM_EMOJIS.default)).join(' ')}
    </div>`;
  }).join('');
  // Render bots with task type and target info
  elements.botsView.innerHTML = bots.map((bot) => {
    const detail = botDetailsMap[bot.id] || {};
    const taskType = detail.taskType || 'none';
    const color = TASK_COLORS[taskType] || TASK_COLORS.none;
    const targetStr = detail.target ? `[${detail.target.join(',')}]` : '-';
    const stallStr = detail.stallCount > 0 ? ` stall:${detail.stallCount}` : '';
    return `<div style="border-left:6px solid ${color};margin-bottom:2px;padding-left:4px;">
      <b>B${bot.id}</b> @ [${bot.position.join(',')}]<br>
      Inv: ${bot.inventory.map((it) => (ITEM_EMOJIS[it.type] || ITEM_EMOJIS.default)).join(' ')}<br>
      Task: <span style="color:${color};font-weight:bold">${taskType}</span> → ${targetStr}${stallStr}
    </div>`;
  }).join('');
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
