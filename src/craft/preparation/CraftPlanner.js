var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var CraftPlanner_exports = {};
__export(CraftPlanner_exports, {
  CraftPlanner: () => CraftPlanner,
  branchCostOf: () => branchCostOf,
  compareBranchCost: () => compareBranchCost,
  createDefaultLeafResolver: () => createDefaultLeafResolver,
  resetResourceMapCacheForTest: () => resetResourceMapCacheForTest
});
module.exports = __toCommonJS(CraftPlanner_exports);
var import_node_fs = __toESM(require("node:fs"));
var import_node_path = __toESM(require("node:path"));
var import_node_url = require("node:url");
var import_versionGuard = require("./versionGuard");
var import_ReconciliationCheck = require("./ReconciliationCheck");
var import_directCollectionCapabilities = require("./directCollectionCapabilities");
var import_LeafResolver = require("./LeafResolver");
var import_RecipeGraph = require("./RecipeGraph");
const DEFAULT_BUDGET = 2e5;
const MAX_DEPTH = 128;
class CraftPlanner {
  graph;
  leafResolver;
  stackSizeOf;
  constructor(graph, options = {}) {
    this.graph = graph;
    this.leafResolver = options.leafResolver ?? (0, import_LeafResolver.createFourGateLeafResolver)();
    this.stackSizeOf = options.stackSizeOf ?? defaultStackSizeOf();
  }
  /**
   * 规划「目标物品 × qty」。
   * @param item 目标物品名（归一化，去 minecraft: 前缀）。
   * @param qty  目标数量（>0）。
   * @param ctx  可用库存快照来源 + 可选叶子接缝覆盖。
   */
  plan(itemRaw, qty, ctx = {}) {
    const item = (0, import_RecipeGraph.stripNamespace)(itemRaw);
    const quantity = Math.max(0, Math.floor(qty));
    const protocolRejection = import_LeafResolver.PROTOCOL_INCOMPATIBLE_ITEMS.has(item) ? {
      reason: `protocol_version_incompatible: bot=1.21.4 server=1.21.11 item=${item}`,
      category: "excluded"
    } : null;
    const capabilityRejection = protocolRejection ? null : (0, import_directCollectionCapabilities.directTargetRejection)(item, process.env);
    const directRejection = protocolRejection ?? capabilityRejection;
    if (quantity > 0 && directRejection) {
      return {
        ok: false,
        target: { name: item, quantity },
        inventoryUses: [],
        collectGaps: [],
        craftSteps: [],
        unreachable: [{
          name: item,
          quantity,
          reason: directRejection.reason,
          category: directRejection.category
        }],
        estimatedSlots: 0
      };
    }
    const initialAvailable = this.buildAvailable(ctx);
    const state = {
      available: initialAvailable,
      stockAvailable: new Map(initialAvailable),
      inventoryUses: /* @__PURE__ */ new Map(),
      path: /* @__PURE__ */ new Set(),
      collect: /* @__PURE__ */ new Map(),
      unreachable: /* @__PURE__ */ new Map(),
      steps: [],
      leafTotal: 0,
      unreachableTotal: 0,
      craftTriggers: 0,
      budget: DEFAULT_BUDGET
    };
    const resolver = ctx.leafResolver ?? this.leafResolver;
    if (quantity > 0) {
      this.planItem(item, quantity, state, resolver, 0);
    }
    const milkGap = state.collect.get("milk_bucket");
    if (milkGap && milkGap.qty > 0) {
      const missingBuckets = this.consumeAvailable(state, "bucket", milkGap.qty);
      if (missingBuckets > 0) {
        state.unreachable.set("bucket", {
          name: "bucket",
          quantity: missingBuckets,
          reason: "\u6324\u5976\u9700\u8981\u7B49\u91CF\u7A7A\u6876\uFF0C\u4E14\u4EA4\u4E92\u524D\u53EA\u80FD\u4F7F\u7528\u878D\u5408\u5E93\u5B58\u4E2D\u7684\u73B0\u6210\u7A7A\u6876",
          category: "out_of_collect_range"
        });
        state.leafTotal += missingBuckets;
      }
    }
    const collectGaps = [...state.collect.values()];
    const unreachable = [...state.unreachable.values()];
    const craftSteps = finalizeSteps(state.steps);
    const estimatedSlots = this.estimateSlots(collectGaps, craftSteps);
    return {
      ok: unreachable.length === 0,
      target: { name: item, quantity },
      inventoryUses: [...state.inventoryUses.entries()].filter(([, used]) => used > 0).sort(([a], [b]) => a.localeCompare(b)).map(([name, used]) => ({ name, quantity: used })),
      collectGaps,
      craftSteps,
      unreachable,
      estimatedSlots
    };
  }
  // -------------------------------------------------------------------------
  // 递归规划核心（§3.2 伪代码）
  // -------------------------------------------------------------------------
  /** 规划 item 的 qty；就地修改 state（available/collect/unreachable/steps/leafTotal）。 */
  planItem(item, qty, state, resolver, depth) {
    let remaining = this.consumeAvailable(state, item, qty);
    if (remaining <= 0) return;
    if (state.budget <= 0 || depth >= MAX_DEPTH) {
      this.handleLeaf(item, remaining, state, resolver);
      return;
    }
    state.budget -= 1;
    if (state.path.has(item)) {
      this.handleLeaf(item, remaining, state, resolver);
      return;
    }
    const directCapability = (0, import_directCollectionCapabilities.directCollectionCapability)(item);
    if (directCapability && (0, import_directCollectionCapabilities.isDirectCollectionEnabled)(directCapability, process.env)) {
      this.handleDirectCapability(item, remaining, state, directCapability);
      return;
    }
    const recipes = this.graph.getRecipesFor(item);
    if (recipes.length === 0) {
      this.handleLeaf(item, remaining, state, resolver);
      return;
    }
    let best = null;
    let bestCost = null;
    const direct = resolver.resolve(item);
    if (direct.reachable && direct.gap) {
      best = cloneState(state);
      this.handleLeaf(item, remaining, best, resolver);
      bestCost = branchCostOf(state, best);
    }
    for (const recipe of recipes) {
      const trial = cloneState(state);
      this.expandRecipe(item, remaining, recipe, trial, resolver, depth);
      const cost = branchCostOf(state, trial);
      if (bestCost === null || compareBranchCost(cost, bestCost) < 0) {
        bestCost = cost;
        best = trial;
      }
    }
    if (best) {
      adoptState(state, best);
    } else {
      this.handleLeaf(item, remaining, state, resolver);
    }
  }
  /**
   * 沿一条配方展开 item 的 qty（就地修改 state）。
   * times = ceil(qty / result.count)；先递归规划各输入（post-order 记步 → 拓扑序），
   * 再把超出所需的产出登记回 available（Req 3.5），最后记录该合成步骤。
   */
  expandRecipe(item, qty, recipe, state, resolver, depth) {
    const count = Math.max(1, recipe.result.count);
    const times = Math.ceil(qty / count);
    const produced = times * count;
    const surplus = produced - qty;
    state.path.add(item);
    for (const input of recipe.inputs) {
      const needed = input.count * times;
      const candidate = this.chooseCandidate(input.names, state);
      this.planItem(candidate, needed, state, resolver, depth + 1);
    }
    state.path.delete(item);
    if (surplus > 0) {
      addAvailable(state, item, surplus);
    }
    state.craftTriggers += times;
    state.steps.push({
      recipeId: recipe.id,
      result: { name: recipe.result.name, count },
      // Ported addition: carry the recipe's 3x3 requirement to the command.
      requiresTable: Boolean(recipe.requiresTable),
      times,
      // 保留「单次触发」的输入位（count 为单次量）；总量 = count * times。
      inputs: recipe.inputs.map((i) => ({ names: [...i.names], count: i.count }))
    });
  }
  /**
   * 在一个输入位的候选集合中择一物品（Req 3.2/3.3 的库存优先 + 最小采集代价）。
   * - 单候选：直接返回。
   * - 有候选已在库存（available>0）：选库存最多者（代价 0，优先吃库存）。
   * - 都不在库存：按「库存无关的静态最小采集代价」staticCost 选最便宜候选。
   *
   * 关键性能修复：旧实现在"都无库存"分支逐候选 cloneState + 递归 planItem 试算，配合无记忆化
   * 会在 tag 多候选（如木板的 11 种原木）× 递归深度上叠成克隆风暴（指数风险）。既然进入本分支
   * 时所有候选均无库存、其代价本就与库存无关，改用记忆化的纯静态代价排序，结果等价且不再克隆递归。
   */
  /**
   * 无库存时，若同一 tag 同时包含普通物与对应 stripped_* 变体，只保留普通物参与静态择优。
   * stripped_* 在资源映射中的 substituteWith 仅表示 tag 等价采集来源，不代表采到普通物后能直接
   * 变成 stripped_*；把它按单位叶子计价会跳过真实合成链（如 bamboo → bamboo_block）。
   * 库存优先判断发生在调用本方法之前，因此仓库真实已有 stripped_* 时仍会直接使用。
   */
  preferUnstrippedCandidates(names) {
    const set = new Set(names);
    const preferred = names.filter((name) => {
      if (!name.startsWith("stripped_")) return true;
      return !set.has(name.slice("stripped_".length));
    });
    return preferred.length > 0 ? preferred : names;
  }
  chooseCandidate(namesRaw, state) {
    const names = namesRaw.map(import_RecipeGraph.stripNamespace);
    if (names.length === 0) return "";
    if (names.length === 1) return names[0];
    let bestStockName = null;
    let bestStock = 0;
    for (const n of names) {
      const stock = state.available.get(n) ?? 0;
      if (stock > bestStock) {
        bestStock = stock;
        bestStockName = n;
      }
    }
    if (bestStockName && bestStock > 0) return bestStockName;
    const candidates = this.preferUnstrippedCandidates(names);
    let bestName = candidates[0];
    let bestCost = Number.POSITIVE_INFINITY;
    for (const n of candidates) {
      const c = this.staticCost(n, /* @__PURE__ */ new Set());
      if (c < bestCost) {
        bestCost = c;
        bestName = n;
      }
    }
    return bestName;
  }
  /**
   * 库存无关的「每单位最小采集叶子数」静态估算（实例级记忆化，供候选择优用）。
   * 递归取各配方输入最便宜候选之和 / 单次产出；查不到配方即叶子（单位代价 1）；
   * 环用 seen 剪除（按叶子计）。因与库存无关且配方静态，缓存对整个进程有效。
   */
  staticCostMemo = /* @__PURE__ */ new Map();
  staticCost(itemRaw, seen) {
    const item = (0, import_RecipeGraph.stripNamespace)(itemRaw);
    const cached = this.staticCostMemo.get(item);
    if (cached !== void 0) return cached;
    if (seen.has(item)) return 1;
    const recipes = this.graph.getRecipesFor(item);
    if (recipes.length === 0) {
      this.staticCostMemo.set(item, 1);
      return 1;
    }
    seen.add(item);
    let best = Number.POSITIVE_INFINITY;
    for (const r of recipes) {
      const count = Math.max(1, r.result.count);
      let sum = 0;
      for (const input of r.inputs) {
        let cheap = Number.POSITIVE_INFINITY;
        for (const n of input.names) {
          const c = this.staticCost(n, seen);
          if (c < cheap) cheap = c;
        }
        if (!Number.isFinite(cheap)) cheap = 1;
        sum += cheap * input.count;
      }
      const per = sum / count;
      if (per < best) best = per;
    }
    seen.delete(item);
    const val = Number.isFinite(best) ? best : 1;
    this.staticCostMemo.set(item, val);
    return val;
  }
  // -------------------------------------------------------------------------
  // 叶子 / 库存 / estimatedSlots 辅助
  // -------------------------------------------------------------------------
  /** 从 available 消费 item 最多 qty，返回消费后仍需的净缺口，并只记录初始融合库存部分。 */
  consumeAvailable(state, item, qty) {
    const have = state.available.get(item) ?? 0;
    if (have <= 0) return qty;
    const take = Math.min(have, qty);
    const left = have - take;
    if (left > 0) state.available.set(item, left);
    else state.available.delete(item);
    const stockHave = state.stockAvailable.get(item) ?? 0;
    const stockTake = Math.min(stockHave, take);
    if (stockTake > 0) {
      const stockLeft = stockHave - stockTake;
      if (stockLeft > 0) state.stockAvailable.set(item, stockLeft);
      else state.stockAvailable.delete(item);
      state.inventoryUses.set(item, (state.inventoryUses.get(item) ?? 0) + stockTake);
    }
    return qty - take;
  }
  /** 把某叶子的 qty 归入 collectGaps（可达）或 unreachable（不可达），并累计 leafTotal。 */
  handleLeaf(item, qty, state, resolver) {
    if (qty <= 0) return;
    const res = resolver.resolve(item);
    if (res.reachable && res.gap) {
      const existing = state.collect.get(item);
      if (existing) {
        existing.qty += qty;
      } else {
        state.collect.set(item, {
          name: item,
          qty,
          method: res.gap.method,
          tool: res.gap.tool,
          sourceBlock: res.gap.sourceBlock,
          biomes: res.gap.biomes,
          yRange: res.gap.yRange,
          mobName: res.gap.mobName ?? null,
          structureProfile: res.gap.structureProfile ?? null
        });
      }
      state.leafTotal += qty;
    } else {
      const reason = res.unreachable?.reason ?? "\u65E0\u53EF\u7528\u914D\u65B9\u4E14\u65E0\u91C7\u96C6\u6765\u6E90";
      const category = res.unreachable?.category ?? "out_of_collect_range";
      const existing = state.unreachable.get(item);
      if (existing) {
        existing.quantity += qty;
      } else {
        state.unreachable.set(item, { name: item, quantity: qty, reason, category });
      }
      state.leafTotal += qty;
      state.unreachableTotal += qty;
    }
  }
  handleDirectCapability(item, qty, state, capability) {
    if (qty <= 0) return;
    const existing = state.collect.get(item);
    if (existing) {
      existing.qty += qty;
    } else {
      state.collect.set(item, {
        name: item,
        qty,
        method: capability.method,
        tool: {
          hasBlockForm: true,
          sourceBlock: capability.sourceBlock,
          material: "mineable/pickaxe",
          harvestTools: null
        },
        sourceBlock: capability.sourceBlock,
        biomes: null,
        yRange: { min: null, max: null },
        mobName: null,
        requiredTool: capability.requiredTool,
        requiredEnchantment: capability.requiredEnchantment,
        pickupValidation: capability.pickupValidation,
        consumables: capability.consumables?.map((entry) => ({ ...entry })),
        capabilityStatus: capability.status,
        dependency: capability.dependency
      });
    }
    state.leafTotal += qty;
  }
  /** 构建初始 available：合并 fusedInventory.overview() 与 ctx.available。 */
  buildAvailable(ctx) {
    const map = /* @__PURE__ */ new Map();
    if (ctx.fusedInventory) {
      const view = ctx.fusedInventory.overview();
      for (const it of view.items ?? []) {
        const name = (0, import_RecipeGraph.stripNamespace)(it.name);
        map.set(name, (map.get(name) ?? 0) + (it.totalCount ?? 0));
      }
    }
    if (ctx.available) {
      for (const [k, v] of Object.entries(ctx.available)) {
        const name = (0, import_RecipeGraph.stripNamespace)(k);
        map.set(name, (map.get(name) ?? 0) + (Number(v) || 0));
      }
    }
    return map;
  }
  /**
   * 量级预检用格子数估算（Req 3.6 / §2 ②）。
   * 上界估算：采集叶子 + 每步合成产出各按其堆叠上限折算格子数（偏保守，宁可拒大单）。
   */
  estimateSlots(collectGaps, craftSteps) {
    let slots = 0;
    for (const gap of collectGaps) {
      slots += Math.ceil(gap.qty / this.stackSizeOf(gap.name));
    }
    for (const step of craftSteps) {
      const produced = step.times * Math.max(1, step.result.count);
      slots += Math.ceil(produced / this.stackSizeOf(step.result.name));
    }
    return slots;
  }
}
function branchCostOf(base, trial) {
  return [
    trial.unreachableTotal - base.unreachableTotal,
    trial.leafTotal - base.leafTotal,
    trial.craftTriggers - base.craftTriggers
  ];
}
function compareBranchCost(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}
function cloneState(s) {
  return {
    available: new Map(s.available),
    stockAvailable: new Map(s.stockAvailable),
    inventoryUses: new Map(s.inventoryUses),
    path: new Set(s.path),
    collect: cloneCollect(s.collect),
    unreachable: new Map(
      [...s.unreachable.entries()].map(([k, v]) => [k, { ...v }])
    ),
    steps: s.steps.map((st) => ({
      recipeId: st.recipeId,
      result: { ...st.result },
      requiresTable: Boolean(st.requiresTable),
      times: st.times,
      inputs: st.inputs.map((i) => ({ names: [...i.names], count: i.count }))
    })),
    leafTotal: s.leafTotal,
    unreachableTotal: s.unreachableTotal,
    craftTriggers: s.craftTriggers,
    budget: s.budget
  };
}
function cloneCollect(m) {
  const out = /* @__PURE__ */ new Map();
  for (const [k, v] of m.entries()) {
    out.set(k, {
      ...v,
      biomes: v.biomes ? [...v.biomes] : null,
      yRange: v.yRange ? { ...v.yRange } : null,
      tool: v.tool ? { ...v.tool, harvestTools: v.tool.harvestTools ? [...v.tool.harvestTools] : null } : null
    });
  }
  return out;
}
function adoptState(target, src) {
  target.available = src.available;
  target.stockAvailable = src.stockAvailable;
  target.inventoryUses = src.inventoryUses;
  target.collect = src.collect;
  target.unreachable = src.unreachable;
  target.steps = src.steps;
  target.leafTotal = src.leafTotal;
  target.unreachableTotal = src.unreachableTotal;
  target.craftTriggers = src.craftTriggers;
  target.budget = src.budget;
}
function addAvailable(state, item, amount) {
  if (amount <= 0) return;
  state.available.set(item, (state.available.get(item) ?? 0) + amount);
}
function finalizeSteps(steps) {
  const merged = /* @__PURE__ */ new Map();
  const order = [];
  for (const s of steps) {
    const cur = merged.get(s.recipeId);
    if (cur) {
      cur.times += s.times;
    } else {
      merged.set(s.recipeId, {
        recipeId: s.recipeId,
        result: { ...s.result },
        requiresTable: Boolean(s.requiresTable),
        times: s.times,
        inputs: s.inputs.map((i) => ({ names: [...i.names], count: i.count }))
      });
      order.push(s.recipeId);
    }
  }
  return order.map((id) => merged.get(id));
}
function defaultResourceMapPath() {
  // Ported: collection-side resource map; keep pointing at cloud-store data/ so the
  // module still loads, the collection leaves themselves are pruned later.
  return import_node_path.default.resolve(__dirname, "../../../data/resource-source-map.json");
}
let cachedResourceMap = null;
function loadResourceMap() {
  if (cachedResourceMap) return cachedResourceMap;
  try {
    const raw = import_node_fs.default.readFileSync(defaultResourceMapPath(), "utf8");
    cachedResourceMap = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    cachedResourceMap = { entries: {} };
  }
  return cachedResourceMap;
}
function resetResourceMapCacheForTest() {
  cachedResourceMap = null;
}
function toGap(entry) {
  const tool = entry.tool ? {
    hasBlockForm: Boolean(entry.tool.hasBlockForm),
    sourceBlock: entry.tool.sourceBlock ?? null,
    material: entry.tool.material ?? "default",
    harvestTools: entry.tool.harvestTools ?? null
  } : null;
  return {
    method: entry.method ?? "harvest_biome",
    tool,
    sourceBlock: entry.tool?.sourceBlock ?? null,
    biomes: entry.biomes ?? null,
    yRange: { min: entry.yRangeMin ?? null, max: entry.yRangeMax ?? null },
    mobName: entry.mobName ?? null
  };
}
function createDefaultLeafResolver() {
  return {
    resolve(itemRaw) {
      const item = (0, import_RecipeGraph.stripNamespace)(itemRaw);
      const map = loadResourceMap();
      const entry = map.entries?.[item];
      if (entry?.method === "farm_crop") {
        return {
          reachable: false,
          unreachable: { reason: "farm_crop \u4E00\u671F\u4E0D\u505A\uFF08seam:2.5 \u56DB\u5C42\u95F8\u95E8\uFF09", category: "out_of_collect_range" }
        };
      }
      if (entry && entry.supported !== false && entry.method) {
        return { reachable: true, gap: toGap(entry) };
      }
      let alias;
      try {
        alias = (0, import_ReconciliationCheck.resolveOreAlias)(item);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          reachable: false,
          unreachable: {
            reason: `${import_ReconciliationCheck.ALIAS_TABLE_UNAVAILABLE_PREFIX}: ${message}`,
            category: "out_of_collect_range"
          }
        };
      }
      if (alias && alias.sources.length > 0) {
        const src = alias.sources[0];
        const tool = src.tool ?? null;
        return {
          reachable: true,
          gap: {
            method: src.method ?? "mine_underground",
            tool,
            sourceBlock: src.sourceBlock ?? null,
            biomes: src.biomes ?? null,
            yRange: src.yRange ?? { min: null, max: null },
            mobName: null
          }
        };
      }
      return {
        reachable: false,
        unreachable: {
          reason: "\u65E0\u53EF\u7528\u914D\u65B9\u4E14\u65E0\u91C7\u96C6\u6765\u6E90\uFF08seam:2.5 \u56DB\u5C42\u95F8\u95E8\u5F85\u8865\uFF09",
          category: "out_of_collect_range"
        }
      };
    }
  };
}
function defaultStackSizeOf() {
  let registry = null;
  try {
    registry = (0, import_versionGuard.loadMcRegistry)();
  } catch {
    registry = null;
  }
  return (nameRaw) => {
    const name = (0, import_RecipeGraph.stripNamespace)(nameRaw);
    const size = registry?.itemsByName?.[name]?.stackSize;
    return typeof size === "number" && size > 0 ? size : 64;
  };
}
