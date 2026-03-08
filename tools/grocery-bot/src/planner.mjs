import { encodeCoord } from './coords.mjs';
import { GridGraph } from './grid-graph.mjs';
import { buildWorldContext } from './world-model.mjs';
import { getRoundPhase } from './planner-utils.mjs';
import {
  executeMissionStrategy,
  executeAssignedTaskStrategy,
  executeWarehouseStrategy,
} from './planner-multibot-runtime.mjs';
import { executeSingleBotTurn } from './planner-singlebot-runtime.mjs';
import {
  resolveRecoveryThreshold,
  isTwoCellOscillation,
  isConfinedLoop,
  decrementCooldownMap,
  addAdaptiveCooldown,
  updateApproachStats,
} from './planner-singlebot.mjs';
import { buildComparableReplayState, diffComparableReplayValues } from './replay-transition-diff.mjs';

export class GroceryPlanner {
  constructor(profile, options = {}) {
    this.profile = profile;
    this.oracle = options.oracle || null;
    this.script = options.script || null;
    this.previousPositions = new Map();
    this.stalls = new Map();
    this.forcedWait = new Map();
    this.lastMetrics = {};
    this.lastScore = null;
    this.noProgressRounds = 0;
    this.pendingPickups = new Map();
    this.blockedPickupByBot = new Map();
    this.blockedApproachByBot = new Map();
    this.pickupFailureStreakByBot = new Map();
    this.approachStatsByBot = new Map();
    this.pickupFailureRoundsByBot = new Map();
    this.recoveryBurstRounds = 0;
    this.resetTriggered = false;
    this.lastActionByBot = new Map();
    this.nonScoringDropStreakByBot = new Map();
    this.lastInventoryByBot = new Map();
    this.lastActiveOrderId = null;
    this.lastActiveOrderIdByBot = new Map();
    this.positionHistoryByBot = new Map();
    this.loopBreakRoundsByBot = new Map();
    this.loopDetectionsThisTick = 0;
    this.targetFocusByBot = new Map();
    this.missionsByBot = new Map();
    this._botDetails = new Map();
    this.scriptDisabled = false;
    this.scriptDivergedAtRound = null;
    this.assumptionCheckDone = false;
    this.assumptionMismatch = null;
    
    // Opener phase state
    this.openerActive = true;
    this.openerBotsInPosition = false;
    this.openerTargetPositions = null;
    this.openerTick = 0;
  }

  resetIntentState() {
    this.pendingPickups = new Map();
    this.blockedPickupByBot = new Map();
    this.blockedApproachByBot = new Map();
    this.pickupFailureStreakByBot = new Map();
    this.pickupFailureRoundsByBot = new Map();
    this.lastActionByBot = new Map();
    this.nonScoringDropStreakByBot = new Map();
    this.positionHistoryByBot = new Map();
    this.loopBreakRoundsByBot = new Map();
    this.targetFocusByBot = new Map();
    this.missionsByBot = new Map();
  }

  getLastMetrics() {
    return this.lastMetrics;
  }

  matchesExpectedScriptState(state, expectedState) {
    if (!expectedState) {
      return {
        matched: true,
        comparableLiveState: null,
        diffs: [],
      };
    }
    const comparableLiveState = buildComparableReplayState(state);
    const diffs = diffComparableReplayValues(expectedState, comparableLiveState);
    return {
      matched: diffs.length === 0,
      comparableLiveState,
      diffs,
    };
  }

  validateOracleAndScriptAssumptions(state) {
    if (this.assumptionCheckDone) {
      return this.assumptionMismatch;
    }

    this.assumptionCheckDone = true;
    const oracleItems = this.oracle?.items;
    if (!Array.isArray(oracleItems) || oracleItems.length === 0) {
      return null;
    }

    const liveItemsById = new Map((state.items || []).map((item) => [item.id, item]));
    const mismatches = [];

    for (const oracleItem of oracleItems) {
      const liveItem = liveItemsById.get(oracleItem.id);
      if (!liveItem) {
        mismatches.push({
          itemId: oracleItem.id,
          reason: 'missing_live_item',
          oracleType: oracleItem.type,
        });
        continue;
      }

      if (oracleItem.type !== liveItem.type) {
        mismatches.push({
          itemId: oracleItem.id,
          reason: 'item_type_mismatch',
          oracleType: oracleItem.type,
          liveType: liveItem.type,
        });
      }
    }

    if (mismatches.length === 0) {
      return null;
    }

    this.assumptionMismatch = {
      reason: 'oracle_item_rotation_mismatch',
      mismatchCount: mismatches.length,
      sample: mismatches.slice(0, 5),
    };

    this.oracle = null;
    this.scriptDisabled = true;
    this.scriptDivergedAtRound = state.round;
    return this.assumptionMismatch;
  }

  plan(state) {
    this._botDetails = new Map();
    const assumptionMismatch = this.validateOracleAndScriptAssumptions(state);
    let scriptFallbackMetrics = null;
    // Only run opener phase for multi-bot games (2+ bots), not during script replay or single-bot/test
    const isMultiBot = state.bots.length > 1;
    const isScripted = !this.scriptDisabled && this.script?.tickMap?.has(state.round);
    if (this.openerActive && isMultiBot && !isScripted) {
      if (!this.openerTargetPositions) {
        // Compute target positions for opener (staggered beneath aisles, closest to drop-off)
        this.openerTargetPositions = computeOpenerTargets(state);
      }
      const openerActions = computeOpenerActions(state, this.openerTargetPositions, this.openerTick);
      this.openerBotsInPosition = checkOpenerBotsInPosition(state, this.openerTargetPositions);
      this.openerTick += 1;
      if (this.openerBotsInPosition) {
        this.openerActive = false;
        // Reset opener state for next game if needed
        this.openerTargetPositions = null;
        this.openerTick = 0;
      }
      return openerActions;
    }

    function computeOpenerTargets(state) {
      // Example: Place bots in staggered formation beneath each aisle, closest to drop-off
      // This is a placeholder; real logic should analyze drop-off and aisle layout
      const dropOff = (state.drop_offs && state.drop_offs[0]) || [0, 0];
      const width = state.grid.width;
      const height = state.grid.height;
      // Place bots in a line below each aisle, as close to drop-off as possible
      const targets = [];
      for (let x = 1; x < width - 1; x += 2) {
        targets.push([x, Math.min(height - 2, dropOff[1] + 2)]);
      }
      return targets.slice(0, state.bots.length);
    }

    function computeOpenerActions(state, targets, tick) {
      // Move each bot toward its assigned target position
      const actions = [];
      for (let i = 0; i < state.bots.length; ++i) {
        const bot = state.bots[i];
        const target = targets[i];
        if (!target) {
          actions.push({ bot_id: bot.id, action: 'wait' });
          continue;
        }
        const [bx, by] = bot.position;
        const [tx, ty] = target;
        let move = null;
        if (bx < tx) move = 'right';
        else if (bx > tx) move = 'left';
        else if (by < ty) move = 'down';
        else if (by > ty) move = 'up';
        else move = 'wait';
        actions.push({ bot_id: bot.id, action: move });
      }
      return actions;
    }

    function checkOpenerBotsInPosition(state, targets) {
      // Return true if all bots are at their target positions
      for (let i = 0; i < state.bots.length; ++i) {
        const bot = state.bots[i];
        const target = targets[i];
        if (!target) continue;
        if (bot.position[0] !== target[0] || bot.position[1] !== target[1]) {
          return false;
        }
      }
      return true;
    }
    // Script replay: if we have precomputed actions for this tick, use them verbatim
    if (!this.scriptDisabled && this.script?.tickMap?.has(state.round)) {
      const scriptEntry = this.script.entryMap?.get(state.round) || {
        tick: state.round,
        actions: this.script.tickMap.get(state.round),
      };
      const scriptStateCheck = this.matchesExpectedScriptState(state, scriptEntry.expected_state);
      if (scriptStateCheck.matched) {
        const scriptedActions = this.script.tickMap.get(state.round);
        this.lastScore = state.score;
        this.lastMetrics = {
          phase: 'scripted',
          scripted: true,
          scriptTrusted: Boolean(scriptEntry.expected_state),
          scriptExpectedStateMatched: Boolean(scriptEntry.expected_state),
        };
        // Update position tracking so handoff to live planner is smooth
        for (const bot of state.bots) {
          this.previousPositions.set(`${bot.id}`, encodeCoord(bot.position));
          const inventoryKey = (bot.inventory || []).slice().sort().join('|');
          this.lastInventoryByBot.set(bot.id, inventoryKey);
        }
        return scriptedActions;
      }

      this.scriptDisabled = true;
      this.scriptDivergedAtRound = state.round;
      scriptFallbackMetrics = {
        scriptDiverged: true,
        scriptDivergedAtRound: state.round,
        scriptExpectedStateMatched: false,
        scriptExpectedStateDiffPath: scriptStateCheck.diffs[0]?.path ?? null,
        scriptExpectedStateDiffSample: scriptStateCheck.diffs.slice(0, 3),
      };
    }

    this.resetTriggered = false;
    this.loopDetectionsThisTick = 0;
    const previousPositionByBot = new Map(this.previousPositions);
    const previousInventoryKeyByBot = new Map(this.lastInventoryByBot);
    const previousScore = this.lastScore;
    const scoreImproved = previousScore === null || state.score > previousScore;
    const activeOrder = state.orders?.find((order) => order.status === 'active' && !order.complete) || null;
    const activeOrderId = activeOrder?.id ?? null;
    const activeOrderChanged = this.lastActiveOrderId !== null && this.lastActiveOrderId !== activeOrderId;
    let operationalProgress = activeOrderChanged;

    for (const bot of state.bots) {
      const botId = bot.id;
      const inventoryKey = (bot.inventory || []).slice().sort().join('|');
      const previousInventory = this.lastInventoryByBot.get(botId);

      if (previousInventory !== undefined && previousInventory !== inventoryKey) {
        operationalProgress = true;
      }
    }

    if (scoreImproved) {
      this.noProgressRounds = 0;
      this.recoveryBurstRounds = 0;
    } else if (operationalProgress) {
      this.noProgressRounds = 0;
    } else {
      this.noProgressRounds += 1;
    }
    this.lastScore = state.score;

    const phase = getRoundPhase(state, this.profile);
    const recoveryThreshold = resolveRecoveryThreshold({
      state,
      phase,
      profile: this.profile,
    });
    const partialDropThreshold = this.profile.recovery?.partial_drop_no_progress_rounds ?? Math.max(18, recoveryThreshold * 2);
    const loopBreakRounds = this.profile.recovery?.loop_break_rounds ?? 5;
    const recoveryBurst = this.profile.recovery?.burst_rounds ?? 8;
    const runtime = this.profile.runtime || {};
    const maxConsecutiveApproachFailures = runtime.max_consecutive_pick_failures_before_forbid ?? 2;
    const approachForbidTtl = runtime.approach_forbid_ttl ?? 40;
    const pickFailureSpiralWindow = runtime.pick_failure_spiral_window ?? 10;
    const pickFailureSpiralThreshold = runtime.pick_failure_spiral_threshold ?? 3;
    const targetLockStallRounds = runtime.target_lock_stall_rounds ?? 12;
    const targetLockForbidTtl = runtime.target_lock_forbid_ttl ?? 30;
    const orderStallBailoutRounds = runtime.order_stall_bailout_rounds ?? 20;

    if (this.noProgressRounds === recoveryThreshold) {
      this.resetIntentState();
      this.recoveryBurstRounds = recoveryBurst;
      this.resetTriggered = true;
    }

    const recoveryMode = this.noProgressRounds >= recoveryThreshold || this.recoveryBurstRounds > 0;
    const forcePartialDrop = this.noProgressRounds >= partialDropThreshold;
    if (this.recoveryBurstRounds > 0) {
      this.recoveryBurstRounds -= 1;
    }

    for (const bot of state.bots) {
      const botId = bot.id;
      const coordKey = encodeCoord(bot.position);
      const history = [...(this.positionHistoryByBot.get(botId) || []), coordKey];
      if (history.length > 10) {
        history.shift();
      }
      this.positionHistoryByBot.set(botId, history);
      if (
        this.noProgressRounds >= 4
        && (
          isTwoCellOscillation(history, 6)
          || isConfinedLoop(history, { window: 12, maxUnique: 4, minLength: 8 })
        )
      ) {
        const remaining = this.loopBreakRoundsByBot.get(botId) || 0;
        this.loopBreakRoundsByBot.set(botId, Math.max(remaining, loopBreakRounds));
        this.loopDetectionsThisTick += 1;
      }

      const inventoryKey = (bot.inventory || []).slice().sort().join('|');
      this.lastInventoryByBot.set(botId, inventoryKey);
      const lastAction = this.lastActionByBot.get(botId);
      let dropStreak = this.nonScoringDropStreakByBot.get(botId) || 0;
      if (lastAction === 'drop_off') {
        dropStreak = scoreImproved ? 0 : dropStreak + 1;
      } else if (scoreImproved) {
        dropStreak = 0;
      }
      this.nonScoringDropStreakByBot.set(botId, dropStreak);

      const pending = this.pendingPickups.get(botId);
      const existingCooldown = this.blockedPickupByBot.get(botId) || new Map();
      const existingApproachCooldown = this.blockedApproachByBot.get(botId) || new Map();
      const failureMap = new Map(this.pickupFailureStreakByBot.get(botId) || new Map());
      const approachStats = new Map(this.approachStatsByBot.get(botId) || new Map());
      const failureRounds = [...(this.pickupFailureRoundsByBot.get(botId) || [])]
        .filter((round) => state.round - round <= pickFailureSpiralWindow);
      const nextCooldown = decrementCooldownMap(existingCooldown);
      const nextApproachCooldown = decrementCooldownMap(existingApproachCooldown);

      if (pending) {
        const inventorySize = (bot.inventory || []).length;
        const observedSuccess = inventorySize >= pending.expectedMinInventory;

        if (observedSuccess) {
          nextCooldown.delete(pending.itemId);
          failureMap.delete(pending.itemId);
          updateApproachStats({
            approachStats,
            itemId: pending.itemId,
            approachCell: pending.approachCell || bot.position,
            succeeded: true,
          });
          this.pendingPickups.delete(botId);
        } else if (state.round >= pending.resolveAfterRound) {
          const failedApproach = updateApproachStats({
            approachStats,
            itemId: pending.itemId,
            approachCell: pending.approachCell || bot.position,
            succeeded: false,
          });
          if (failedApproach && failedApproach.stats.consecutiveFailures >= maxConsecutiveApproachFailures) {
            const currentApproachCooldown = nextApproachCooldown.get(failedApproach.key) || 0;
            nextApproachCooldown.set(failedApproach.key, Math.max(currentApproachCooldown, approachForbidTtl));
          }
          addAdaptiveCooldown({
            cooldownMap: nextCooldown,
            failureMap,
            itemId: pending.itemId,
            baseTtl: 4,
            maxTtl: 24,
          });
          failureRounds.push(state.round);
          this.pendingPickups.delete(botId);
        }
      }

      this.blockedPickupByBot.set(botId, nextCooldown);
      this.blockedApproachByBot.set(botId, nextApproachCooldown);
      this.pickupFailureStreakByBot.set(botId, failureMap);
      this.approachStatsByBot.set(botId, approachStats);
      this.pickupFailureRoundsByBot.set(botId, failureRounds);
    }
    this.lastActiveOrderId = activeOrderId;

    const shelfWalls = state.items.map((item) => item.position);
    // Define strict one-way roads (example: vertical conveyor up left, down right)
    const oneWayRoads = buildOneWayRoads(state);
    const graph = new GridGraph({
      ...state.grid,
      walls: [...state.grid.walls, ...shelfWalls],
      oneWayRoads,
    });
    // --- Strict One-Way Road System ---
    function buildOneWayRoads(state) {
      // Example: create a conveyor system with up/down/left/right lanes
      // This is a placeholder; real logic should analyze the map and desired road layout
      const roads = {};
      const width = state.grid.width;
      const height = state.grid.height;
      // Example: leftmost column is up only, rightmost is down only
      for (let y = 1; y < height - 1; ++y) {
        roads[`1,${y}`] = ['up'];
        roads[`${width - 2},${y}`] = ['down'];
      }
      // Example: top row is right only, bottom row is left only
      for (let x = 1; x < width - 1; ++x) {
        roads[`${x},1`] = ['right'];
        roads[`${x},${height - 2}`] = ['left'];
      }
      return roads;
    }
    const world = buildWorldContext(state);

    if (state.bots.length === 1) {
      const actions = executeSingleBotTurn({
        planner: this,
        state,
        world,
        graph,
        phase,
        recoveryMode,
        forcePartialDrop,
        recoveryThreshold,
        loopBreakRounds,
        targetLockStallRounds,
        targetLockForbidTtl,
        orderStallBailoutRounds,
        pickFailureSpiralWindow,
        pickFailureSpiralThreshold,
        scoreImproved,
        operationalProgress,
        activeOrderId,
      });
      if (scriptFallbackMetrics) {
        this.lastMetrics = {
          ...(this.lastMetrics || {}),
          ...scriptFallbackMetrics,
        };
      }
      if (assumptionMismatch) {
        this.lastMetrics = {
          ...(this.lastMetrics || {}),
          oracleDisabled: true,
          scriptDisabled: true,
          assumptionMismatch,
        };
      }
      return actions;
    }

    // Assign bots to zones, allow dynamic switching if needed
    if (!this.zoneAssignmentByBot) {
      this.zoneAssignmentByBot = assignInitialZones(state);
    }
    updateDynamicZones(state, this.zoneAssignmentByBot);
    const blockedItemsByBot = new Map(
      state.bots.map((bot) => [bot.id, this.blockedPickupByBot.get(bot.id) || new Map()]),
    );
    // --- Zone Assignment Helpers ---
    function assignInitialZones(state) {
      // Assign each bot to a zone (e.g., left, middle, right, etc.)
      const zones = {};
      const botOrder = [...state.bots].sort((a, b) => a.id - b.id);
      for (let i = 0; i < botOrder.length; ++i) {
        zones[botOrder[i].id] = i;
      }
      return zones;
    }

    function updateDynamicZones(state, zones) {
      // Allow bots to switch zones if their zone is congested or in recovery
      // Placeholder: if a bot is stuck (no progress for 4+ rounds), reassign to next zone
      for (const bot of state.bots) {
        const botId = bot.id;
        // Example: if bot is in recovery or has not moved, switch zone
        // (Real logic should use actual congestion/recovery detection)
        // For now, do nothing unless you want to implement dynamic switching
        // zones[botId] = ...
      }
    }
    if (runtime.multi_bot_strategy === 'mission_v1') {
      const actions = executeMissionStrategy({
        planner: this,
        state,
        world,
        graph,
        phase,
        recoveryMode,
        recoveryThreshold,
        blockedItemsByBot,
        previousPositionByBot,
        previousInventoryKeyByBot,
      });
      if (scriptFallbackMetrics) {
        this.lastMetrics = {
          ...(this.lastMetrics || {}),
          ...scriptFallbackMetrics,
        };
      }
      if (assumptionMismatch) {
        this.lastMetrics = {
          ...(this.lastMetrics || {}),
          oracleDisabled: true,
          scriptDisabled: true,
          assumptionMismatch,
        };
      }
      return actions;
    }

    if (runtime.multi_bot_strategy === 'warehouse_v1') {
      const actions = executeWarehouseStrategy({
        planner: this,
        state,
        world,
        graph,
        phase,
        recoveryMode,
        recoveryThreshold,
        blockedItemsByBot,
        previousPositionByBot,
        previousInventoryKeyByBot,
      });
      if (scriptFallbackMetrics) {
        this.lastMetrics = {
          ...(this.lastMetrics || {}),
          ...scriptFallbackMetrics,
        };
      }
      if (assumptionMismatch) {
        this.lastMetrics = {
          ...(this.lastMetrics || {}),
          oracleDisabled: true,
          scriptDisabled: true,
          assumptionMismatch,
        };
      }
      return actions;
    }

    const actions = executeAssignedTaskStrategy({
      planner: this,
      state,
      world,
      graph,
      phase,
      recoveryMode,
      recoveryThreshold,
      blockedItemsByBot,
      oracle: this.oracle,
    });
    if (scriptFallbackMetrics) {
      this.lastMetrics = {
        ...(this.lastMetrics || {}),
        ...scriptFallbackMetrics,
      };
    }
    if (assumptionMismatch) {
      this.lastMetrics = {
        ...(this.lastMetrics || {}),
        oracleDisabled: true,
        scriptDisabled: true,
        assumptionMismatch,
      };
    }
    return actions;
  }
}
