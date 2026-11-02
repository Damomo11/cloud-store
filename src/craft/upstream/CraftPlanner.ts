// 备料系统 · 阶段2 — W1 自研合成引擎 CraftPlanner（库存感知 + 正反向混合规划，离线可单测）。
// 依据 design.md §3.2（递归规划伪代码）/ §11.1（最小采集叶子总量为优化目标）与
// requirements.md Requirement 3.1–3.6：
//   3.1 先快照 Fused_Inventory_Store 融合库存总览作为可用库存，库存中已有的成品/中间产物/
//       可反拆方块的采集代价计为零。
//   3.2 优先从可用库存消费该物品，仅对净缺口继续展开配方或采集。
//   3.3 为净缺口枚举全部可用配方，选使「需采集叶子总量」最小的分支
//       （库存有 iron_block 时选反拆为 iron_ingot 而非挖矿）。
//   3.4 维护祖先物品集合，当前物品已在祖先集合中时停止沿该分支展开（防 ingot↔block↔nugget 环）。
//   3.5 一次合成产出超过所需数量时，将超出部分登记回可用库存供后续输入优先消费。
//   3.6 产出 CraftPlan（collectGaps, craftSteps 拓扑序, unreachable, estimatedSlots）。
//
// 本任务（2.4）聚焦「递归规划 / 库存优先 / 环剪除 / 副产物复用 / 拓扑序输出 / estimatedSlots」。
// 叶子可达性的完整「四层闸门 + 硬排除」判定是任务 2.5 的职责——本文件通过可注入的
// LeafResolver 接缝（seam）把叶子判定外置：默认实现 createDefaultLeafResolver() 只做最小
// 兜底（能明确采集的叶子给 collectGap，否则给 unreachable 占位），任务 2.5 将以完整四层闸门 +
// 硬排除实现替换/扩展该 resolver，无需改动本规划器主体。
//
// 规划真值源：以 recipes.json(1.21.4) 的物品名（去 minecraft: 前缀归一化）为唯一真值源。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadMcRegistry } from "./versionGuard";
import { ALIAS_TABLE_UNAVAILABLE_PREFIX, resolveOreAlias } from "./ReconciliationCheck";
import {
  type DirectCollectionCapability,
  directCollectionCapability,
  directTargetRejection,
  isDirectCollectionEnabled,
} from "./directCollectionCapabilities";
import {
  createFourGateLeafResolver,
  PROTOCOL_INCOMPATIBLE_ITEMS,
} from "./LeafResolver";
import { stripNamespace, type RecipeGraph } from "./RecipeGraph";
import type {
  CollectGap,
  CollectMethod,
  CollectTool,
  CraftPlan,
  CraftStep,
  ReasonCategory,
  UsableRecipe,
  Unreachable,
  YRange,
} from "./types";

// ---------------------------------------------------------------------------
// 叶子判定接缝（seam）—— 任务 2.5 以完整四层闸门 + 硬排除填充/替换
// ---------------------------------------------------------------------------

/**
 * 叶子可达性判定结果。CraftPlanner 只负责把 qty 累加进对应桶，
 * 采集方式 / 不可达原因由 LeafResolver 决定（qty 无关，故此结构不含 qty）。
 */
export interface LeafResolution {
  /** 该叶子是否可采集。 */
  reachable: boolean;
  /** reachable=true 时的采集元信息（不含 qty，由规划器补齐净缺口数量）。 */
  gap?: {
    method: CollectMethod;
    tool: CollectTool | null;
    sourceBlock: string | null;
    biomes: string[] | null;
    yRange: YRange | null;
    /** mob_drop 时掉落该物品的生物名（beef→cow）；非 mob_drop 为 null。 */
    mobName: string | null;
    /** harvest_structure 的声明式现场验证约束；其他方法为 null。 */
    structureProfile?: CollectGap["structureProfile"];
  };
  /** reachable=false 时的不可达原因。 */
  unreachable?: { reason: string; category: ReasonCategory };
}

/**
 * 叶子判定接缝。CraftPlanner 在把某物品判为叶子（无可用配方或全部配方分支被环剪除）时调用。
 * 默认实现见 {@link createDefaultLeafResolver}；任务 2.5 提供完整四层闸门 + 硬排除的实现注入。
 */
export interface LeafResolver {
  resolve(item: string): LeafResolution;
}

// ---------------------------------------------------------------------------
// plan() 输入
// ---------------------------------------------------------------------------

/** 极简融合库存快照来源（只需 overview().items 的 name/totalCount）。 */
export interface InventorySnapshotSource {
  overview(): { items: Array<{ name: string; totalCount: number }> };
}

export interface PlanContext {
  /**
   * 可用库存快照（物品名 → 数量）。离线单测直接注入此 map 即可（无需 live store）。
   * 与 fusedInventory 同时给出时二者合并（available 覆盖/叠加于 store 之上）。
   */
  available?: Record<string, number>;
  /** 可选：live Fused_Inventory_Store（或任意实现 overview() 者），规划期调用 overview() 建 available。 */
  fusedInventory?: InventorySnapshotSource;
  /** 可选：叶子判定接缝覆盖（默认用构造器传入或 createDefaultLeafResolver()）。 */
  leafResolver?: LeafResolver;
}

// ---------------------------------------------------------------------------
// 内部规划状态
// ---------------------------------------------------------------------------

interface PlanState {
  /** 可变库存/副产物余量（物品名 → 数量）；库存代价=0，消费即扣减。 */
  available: Map<string, number>;
  /** available 中仍来自初始融合库存的余量；合成副产物只进入 available。 */
  stockAvailable: Map<string, number>;
  /** 实际从初始融合库存消费的数量；配方副产物不会写入此表。 */
  inventoryUses: Map<string, number>;
  /** 祖先物品集合（防环）。 */
  path: Set<string>;
  /** 已累计的需采集叶子（name → CollectGap，qty 累加）。 */
  collect: Map<string, CollectGap>;
  /** 已累计的不可达条目（name → Unreachable，quantity 累加）。 */
  unreachable: Map<string, Unreachable>;
  /** 已累计的合成步骤（post-order 追加，天然拓扑序）。 */
  steps: CraftStep[];
  /** 已累计的「需采集叶子总量」（含不可达量；分支择优的主代价度量）。 */
  leafTotal: number;
  /**
   * 已累计的「不可达叶子总量」。分支择优的首要度量：只要存在完全可达的分支，就绝不能
   * 因为不可达分支的叶子数更小而选它（那会把本可完成的订单直接判成整单拒绝）。
   */
  unreachableTotal: number;
  /**
   * 已累计的配方触发次数。分支择优的末位度量：叶子量与可达性相同时，选合成次数更少的链，
   * 直接减少真服里的取料/合成/入桶往返，降低耗时与中途出错概率。
   */
  craftTriggers: number;
  /** 剩余操作预算（终止兜底，防病态爆炸）。 */
  budget: number;
}

const DEFAULT_BUDGET = 200_000;
const MAX_DEPTH = 128;

// ---------------------------------------------------------------------------
// CraftPlanner
// ---------------------------------------------------------------------------

export class CraftPlanner {
  private readonly graph: RecipeGraph;
  private readonly leafResolver: LeafResolver;
  private readonly stackSizeOf: (name: string) => number;

  constructor(
    graph: RecipeGraph,
    options: { leafResolver?: LeafResolver; stackSizeOf?: (name: string) => number } = {},
  ) {
    this.graph = graph;
    // 默认使用任务 2.5 的完整「四层闸门 + 硬排除」判定（见 LeafResolver.ts）；
    // createDefaultLeafResolver() 仍保留为最小兜底，可经 options.leafResolver 注入覆盖。
    this.leafResolver = options.leafResolver ?? createFourGateLeafResolver();
    this.stackSizeOf = options.stackSizeOf ?? defaultStackSizeOf();
  }

  /**
   * 规划「目标物品 × qty」。
   * @param item 目标物品名（归一化，去 minecraft: 前缀）。
   * @param qty  目标数量（>0）。
   * @param ctx  可用库存快照来源 + 可选叶子接缝覆盖。
   */
  plan(itemRaw: string, qty: number, ctx: PlanContext = {}): CraftPlan {
    const item = stripNamespace(itemRaw);
    const quantity = Math.max(0, Math.floor(qty));

    // Target-level rejections must happen before inventory-first consumption.
    // These restrictions apply only to the order target; such items remain valid
    // internal recipe inputs, where normal inventory and recipe planning applies.
    const protocolRejection = PROTOCOL_INCOMPATIBLE_ITEMS.has(item)
      ? {
          reason: `protocol_version_incompatible: bot=1.21.4 server=1.21.11 item=${item}`,
          category: "excluded" as ReasonCategory,
        }
      : null;
    const capabilityRejection = protocolRejection ? null : directTargetRejection(item, process.env);
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
          category: directRejection.category,
        }],
        estimatedSlots: 0,
      };
    }

    const initialAvailable = this.buildAvailable(ctx);
    const state: PlanState = {
      available: initialAvailable,
      stockAvailable: new Map(initialAvailable),
      inventoryUses: new Map<string, number>(),
      path: new Set<string>(),
      collect: new Map<string, CollectGap>(),
      unreachable: new Map<string, Unreachable>(),
      steps: [],
      leafTotal: 0,
      unreachableTotal: 0,
      craftTriggers: 0,
      budget: DEFAULT_BUDGET,
    };

    const resolver = ctx.leafResolver ?? this.leafResolver;

    if (quantity > 0) {
      this.planItem(item, quantity, state, resolver, 0);
    }

    // milk_bucket 不是无前置的自然掉落：每桶奶会消耗一个空桶。交互阶段发生在正式
    // craft_plan 之前，因此这里只允许使用融合库存中现成的 bucket，并把它记录进
    // inventoryUses 交由 PreparationService 在采集前搬入 buffer；不能把未来才会合成的桶
    // 当成当前可用前置材料。库存不足时整单明确不可达，避免 bot 到牛旁才 no_empty_bucket。
    const milkGap = state.collect.get("milk_bucket");
    if (milkGap && milkGap.qty > 0) {
      const missingBuckets = this.consumeAvailable(state, "bucket", milkGap.qty);
      if (missingBuckets > 0) {
        state.unreachable.set("bucket", {
          name: "bucket",
          quantity: missingBuckets,
          reason: "挤奶需要等量空桶，且交互前只能使用融合库存中的现成空桶",
          category: "out_of_collect_range",
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
      inventoryUses: [...state.inventoryUses.entries()]
        .filter(([, used]) => used > 0)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, used]) => ({ name, quantity: used })),
      collectGaps,
      craftSteps,
      unreachable,
      estimatedSlots,
    };
  }

  // -------------------------------------------------------------------------
  // 递归规划核心（§3.2 伪代码）
  // -------------------------------------------------------------------------

  /** 规划 item 的 qty；就地修改 state（available/collect/unreachable/steps/leafTotal）。 */
  private planItem(
    item: string,
    qty: number,
    state: PlanState,
    resolver: LeafResolver,
    depth: number,
  ): void {
    // 步骤1：先从 available 消费该物品（库存代价=0），仅对净缺口继续展开（Req 3.1/3.2）。
    let remaining = this.consumeAvailable(state, item, qty);

    // 步骤2：纯库存即满足。
    if (remaining <= 0) return;

    // 终止兜底：预算耗尽或超深 → 当叶子处理，交给 resolver（防病态递归）。
    if (state.budget <= 0 || depth >= MAX_DEPTH) {
      this.handleLeaf(item, remaining, state, resolver);
      return;
    }
    state.budget -= 1;

    // 步骤3：环剪除——item 已在祖先链中，停止沿该分支展开配方，落为叶子（Req 3.4）。
    if (state.path.has(item)) {
      this.handleLeaf(item, remaining, state, resolver);
      return;
    }

    // 步骤4：枚举直接采集与全部可用配方，选总代价最小的分支（Req 3.3）。
    // Capability-backed direct targets are resolved before recipe/leaf fallback.
    // Their exact-pickup and tool requirements must survive into the collect gap.
    const directCapability = directCollectionCapability(item);
    if (directCapability && isDirectCollectionEnabled(directCapability, process.env)) {
      this.handleDirectCapability(item, remaining, state, directCapability);
      return;
    }

    const recipes = this.graph.getRecipesFor(item);
    if (recipes.length === 0) {
      // 步骤5：无可用配方 → 叶子。
      this.handleLeaf(item, remaining, state, resolver);
      return;
    }

    // 分支择优按三级字典序比较（见 branchCostOf）：
    //   ① 不可达量最小 —— 存在完全可达分支时绝不选不可达分支（否则整单被误拒）；
    //   ② 需采集叶子量最小 —— 原有的主代价（Req 3.3）；
    //   ③ 配方触发次数最小 —— 同等成本下选真服执行更快、往返更少的链。
    // 可直接采集的物品也可能拥有压缩/拆分配方（redstone ↔ redstone_block）。旧实现只要
    // 看见配方就不再比较直接采集，导致 redstone×8 被规划成「挖 9 → 压块 → 拆回 9」。
    // 把叶子方案作为同级候选后，现有三级代价会自然选择更少采集、更少触发的路径；若该
    // 物品不可直接采集，其 unreachable 代价又会让可达配方正常胜出。
    let best: PlanState | null = null;
    let bestCost: BranchCost | null = null;
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
      // 理论不可达（recipes 非空必有 trial）；兜底当叶子。
      this.handleLeaf(item, remaining, state, resolver);
    }
  }

  /**
   * 沿一条配方展开 item 的 qty（就地修改 state）。
   * times = ceil(qty / result.count)；先递归规划各输入（post-order 记步 → 拓扑序），
   * 再把超出所需的产出登记回 available（Req 3.5），最后记录该合成步骤。
   */
  private expandRecipe(
    item: string,
    qty: number,
    recipe: UsableRecipe,
    state: PlanState,
    resolver: LeafResolver,
    depth: number,
  ): void {
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

    // Req 3.5：一次合成产出 > 所需 → 超出量登记回 available，供后续 input 优先消费。
    if (surplus > 0) {
      addAvailable(state, item, surplus);
    }

    // 触发次数累计供分支择优的末位度量使用（同等采集成本下偏好更少的真服合成往返）。
    state.craftTriggers += times;

    // post-order 记步：产物的输入步骤已先行追加，保证叶子→成品拓扑序。
    state.steps.push({
      recipeId: recipe.id,
      result: { name: recipe.result.name, count },
      // Ported addition: carry the recipe's 3x3 requirement to the command.
      requiresTable: Boolean(recipe.requiresTable),
      times,
      // 保留「单次触发」的输入位（count 为单次量）；总量 = count * times。
      inputs: recipe.inputs.map((i) => ({ names: [...i.names], count: i.count })),
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
  private preferUnstrippedCandidates(names: string[]): string[] {
    const set = new Set(names);
    const preferred = names.filter((name) => {
      if (!name.startsWith("stripped_")) return true;
      return !set.has(name.slice("stripped_".length));
    });
    return preferred.length > 0 ? preferred : names;
  }

  private chooseCandidate(namesRaw: string[], state: PlanState): string {
    const names = namesRaw.map(stripNamespace);
    if (names.length === 0) return "";
    if (names.length === 1) return names[0];

    // 库存优先：选可用余量最多的候选；真实 stripped_* 库存也允许直接使用。
    let bestStockName: string | null = null;
    let bestStock = 0;
    for (const n of names) {
      const stock = state.available.get(n) ?? 0;
      if (stock > bestStock) {
        bestStock = stock;
        bestStockName = n;
      }
    }
    if (bestStockName && bestStock > 0) return bestStockName;

    // 都无库存：先剔除与普通等价物并存的 stripped_* 伪捷径，再按静态成本择优。
    const candidates = this.preferUnstrippedCandidates(names);
    let bestName = candidates[0];
    let bestCost = Number.POSITIVE_INFINITY;
    for (const n of candidates) {
      const c = this.staticCost(n, new Set<string>());
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
  private readonly staticCostMemo = new Map<string, number>();

  private staticCost(itemRaw: string, seen: Set<string>): number {
    const item = stripNamespace(itemRaw);
    const cached = this.staticCostMemo.get(item);
    if (cached !== undefined) return cached;
    if (seen.has(item)) return 1; // 环：按叶子单位代价，不缓存该临时值
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
  private consumeAvailable(state: PlanState, item: string, qty: number): number {
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
  private handleLeaf(item: string, qty: number, state: PlanState, resolver: LeafResolver): void {
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
          structureProfile: res.gap.structureProfile ?? null,
        });
      }
      // 「需采集叶子总量」用于分支择优（Req 3.3）。
      state.leafTotal += qty;
    } else {
      const reason = res.unreachable?.reason ?? "无可用配方且无采集来源";
      const category: ReasonCategory = res.unreachable?.category ?? "out_of_collect_range";
      const existing = state.unreachable.get(item);
      if (existing) {
        existing.quantity += qty;
      } else {
        state.unreachable.set(item, { name: item, quantity: qty, reason, category });
      }
      // 不可达也计入 leafTotal，避免规划器为了「回避不可达」而在多个都不可达的分支间乱选。
      state.leafTotal += qty;
      // 同时单独累计不可达量：分支择优以它为首要度量，保证「存在完全可达分支时必选可达分支」，
      // 不会因为不可达分支的叶子数更小（例如缺 1 个不可达物 vs 采 10 个可达物）而误拒整单。
      state.unreachableTotal += qty;
    }
  }

  private handleDirectCapability(
    item: string,
    qty: number,
    state: PlanState,
    capability: DirectCollectionCapability,
  ): void {
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
          harvestTools: null,
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
        dependency: capability.dependency,
      });
    }
    state.leafTotal += qty;
  }

  /** 构建初始 available：合并 fusedInventory.overview() 与 ctx.available。 */
  private buildAvailable(ctx: PlanContext): Map<string, number> {
    const map = new Map<string, number>();
    if (ctx.fusedInventory) {
      const view = ctx.fusedInventory.overview();
      for (const it of view.items ?? []) {
        const name = stripNamespace(it.name);
        map.set(name, (map.get(name) ?? 0) + (it.totalCount ?? 0));
      }
    }
    if (ctx.available) {
      for (const [k, v] of Object.entries(ctx.available)) {
        const name = stripNamespace(k);
        map.set(name, (map.get(name) ?? 0) + (Number(v) || 0));
      }
    }
    return map;
  }

  /**
   * 量级预检用格子数估算（Req 3.6 / §2 ②）。
   * 上界估算：采集叶子 + 每步合成产出各按其堆叠上限折算格子数（偏保守，宁可拒大单）。
   */
  private estimateSlots(collectGaps: CollectGap[], craftSteps: CraftStep[]): number {
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

// ---------------------------------------------------------------------------
// 状态克隆 / 采纳 / available 辅助
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 分支代价（三级字典序）
// ---------------------------------------------------------------------------

/** [不可达增量, 需采集叶子增量, 配方触发增量]，按此优先级字典序比较。 */
export type BranchCost = readonly [number, number, number];

/** 某个 trial 相对基线 state 的分支代价增量。 */
export function branchCostOf(base: PlanState | { leafTotal: number; unreachableTotal: number; craftTriggers: number }, trial: PlanState | { leafTotal: number; unreachableTotal: number; craftTriggers: number }): BranchCost {
  return [
    trial.unreachableTotal - base.unreachableTotal,
    trial.leafTotal - base.leafTotal,
    trial.craftTriggers - base.craftTriggers,
  ];
}

/** 字典序比较：<0 表示 a 更优。 */
export function compareBranchCost(a: BranchCost, b: BranchCost): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function cloneState(s: PlanState): PlanState {
  return {
    available: new Map(s.available),
    stockAvailable: new Map(s.stockAvailable),
    inventoryUses: new Map(s.inventoryUses),
    path: new Set(s.path),
    collect: cloneCollect(s.collect),
    unreachable: new Map(
      [...s.unreachable.entries()].map(([k, v]) => [k, { ...v }]),
    ),
    steps: s.steps.map((st) => ({
      recipeId: st.recipeId,
      result: { ...st.result },
      times: st.times,
      inputs: st.inputs.map((i) => ({ names: [...i.names], count: i.count })),
    })),
    leafTotal: s.leafTotal,
    unreachableTotal: s.unreachableTotal,
    craftTriggers: s.craftTriggers,
    budget: s.budget,
  };
}

function cloneCollect(m: Map<string, CollectGap>): Map<string, CollectGap> {
  const out = new Map<string, CollectGap>();
  for (const [k, v] of m.entries()) {
    out.set(k, {
      ...v,
      biomes: v.biomes ? [...v.biomes] : null,
      yRange: v.yRange ? { ...v.yRange } : null,
      tool: v.tool ? { ...v.tool, harvestTools: v.tool.harvestTools ? [...v.tool.harvestTools] : null } : null,
    });
  }
  return out;
}

/** 采纳 trial 的规划结果到 target（path 保持 target 当前层不变）。 */
function adoptState(target: PlanState, src: PlanState): void {
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

function addAvailable(state: PlanState, item: string, amount: number): void {
  if (amount <= 0) return;
  state.available.set(item, (state.available.get(item) ?? 0) + amount);
}

// ---------------------------------------------------------------------------
// craftSteps 收尾：按 recipeId 合并触发次数，保持拓扑序（post-order 首次出现序即拓扑序）
// ---------------------------------------------------------------------------

/**
 * 合并同一配方的多次触发（times 相加），保持首次出现顺序。
 * post-order 追加保证：任一产物的输入配方步骤总在该产物步骤之前首次出现，
 * 故「首次出现序」即为合法的叶子→成品拓扑序。
 */
function finalizeSteps(steps: CraftStep[]): CraftStep[] {
  const merged = new Map<string, CraftStep>();
  const order: string[] = [];
  for (const s of steps) {
    const cur = merged.get(s.recipeId);
    if (cur) {
      cur.times += s.times;
    } else {
      merged.set(s.recipeId, {
        recipeId: s.recipeId,
        result: { ...s.result },
        times: s.times,
        inputs: s.inputs.map((i) => ({ names: [...i.names], count: i.count })),
      });
      order.push(s.recipeId);
    }
  }
  return order.map((id) => merged.get(id)!);
}

// ---------------------------------------------------------------------------
// 默认叶子接缝实现（最小兜底；任务 2.5 以完整四层闸门 + 硬排除替换）
// ---------------------------------------------------------------------------

interface ResourceSourceEntry {
  itemName?: string;
  supported?: boolean;
  method?: string;
  mobName?: string | null;
  biomes?: string[] | null;
  yRangeMin?: number | null;
  yRangeMax?: number | null;
  poolStatus?: string | null;
  tool?: {
    hasBlockForm?: boolean;
    sourceBlock?: string | null;
    material?: string;
    harvestTools?: string[] | null;
  } | null;
}

interface ResourceSourceMap {
  entries?: Record<string, ResourceSourceEntry>;
}

function defaultResourceMapPath(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  // src/core/preparation → 向上 3 级到 src-api，读取 src-api/data/resource-source-map.json。
  return path.resolve(__dirname, "../../../data/resource-source-map.json");
}

let cachedResourceMap: ResourceSourceMap | null = null;
function loadResourceMap(): ResourceSourceMap {
  if (cachedResourceMap) return cachedResourceMap;
  try {
    const raw = fs.readFileSync(defaultResourceMapPath(), "utf8");
    cachedResourceMap = JSON.parse(raw.replace(/^\uFEFF/, "")) as ResourceSourceMap;
  } catch {
    cachedResourceMap = { entries: {} };
  }
  return cachedResourceMap;
}

/** 仅供测试：清除 resource-source-map 缓存。 */
export function resetResourceMapCacheForTest(): void {
  cachedResourceMap = null;
}

function toGap(entry: ResourceSourceEntry): LeafResolution["gap"] {
  const tool: CollectTool | null = entry.tool
    ? {
        hasBlockForm: Boolean(entry.tool.hasBlockForm),
        sourceBlock: entry.tool.sourceBlock ?? null,
        material: entry.tool.material ?? "default",
        harvestTools: entry.tool.harvestTools ?? null,
      }
    : null;
  return {
    method: (entry.method as CollectMethod) ?? "harvest_biome",
    tool,
    sourceBlock: entry.tool?.sourceBlock ?? null,
    biomes: entry.biomes ?? null,
    yRange: { min: entry.yRangeMin ?? null, max: entry.yRangeMax ?? null },
    mobName: entry.mobName ?? null,
  };
}

/**
 * 默认叶子判定接缝（最小兜底实现）。
 *
 * ⚠️ 这是任务 2.4 留给任务 2.5 的接缝占位，**不是**完整的四层闸门 + 硬排除判定：
 *   - 仅：resource-source-map 里 supported 且带 method 的叶子 → 明确可采集 → collectGap；
 *     product↔ore 别名命中（如 coal/raw_iron）→ collectGap；
 *   - 其余一律给 unreachable 占位（category=out_of_collect_range）。
 * 任务 2.5 将以完整逻辑替换：① unsupported-composite-items（23 条）；② poolStatus
 *   excluded/sealed → unreachable；③ stripped_* 的 substituteWith 重定向；④ 按 method 派执行器；
 *   ⑤ 硬排除（钻石矿/下界矿/怪物掉落/水生/farm_crop）。届时只需替换本 resolver，规划器主体不变。
 */
export function createDefaultLeafResolver(): LeafResolver {
  return {
    resolve(itemRaw: string): LeafResolution {
      const item = stripNamespace(itemRaw);
      const map = loadResourceMap();
      const entry = map.entries?.[item];

      // farm_crop 一期不做（D6）——占位判不可达，2.5 会给出更精确原因。
      if (entry?.method === "farm_crop") {
        return {
          reachable: false,
          unreachable: { reason: "farm_crop 一期不做（seam:2.5 四层闸门）", category: "out_of_collect_range" },
        };
      }

      // 明确可采集：supported !== false 且带 method。
      if (entry && entry.supported !== false && entry.method) {
        return { reachable: true, gap: toGap(entry) };
      }

      // product↔ore 别名（如 coal↔coal_ore、raw_iron↔iron_ore）。
      let alias: ReturnType<typeof resolveOreAlias>;
      try {
        alias = resolveOreAlias(item);
      } catch (error) {
        // 别名表读取失败必须如实上报：伪装成「无采集来源」会把数据问题指向错误的排查方向。
        const message = error instanceof Error ? error.message : String(error);
        return {
          reachable: false,
          unreachable: {
            reason: `${ALIAS_TABLE_UNAVAILABLE_PREFIX}: ${message}`,
            category: "out_of_collect_range",
          },
        };
      }
      if (alias && alias.sources.length > 0) {
        const src = alias.sources[0];
        const tool: CollectTool | null = src.tool ?? null;
        return {
          reachable: true,
          gap: {
            method: (src.method as CollectMethod) ?? "mine_underground",
            tool,
            sourceBlock: src.sourceBlock ?? null,
            biomes: src.biomes ?? null,
            yRange: src.yRange ?? { min: null, max: null },
            mobName: null,
          },
        };
      }

      return {
        reachable: false,
        unreachable: {
          reason: "无可用配方且无采集来源（seam:2.5 四层闸门待补）",
          category: "out_of_collect_range",
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 堆叠上限查询（estimatedSlots 用）
// ---------------------------------------------------------------------------

function defaultStackSizeOf(): (name: string) => number {
  let registry: ReturnType<typeof loadMcRegistry> | null = null;
  try {
    registry = loadMcRegistry();
  } catch {
    registry = null;
  }
  return (nameRaw: string): number => {
    const name = stripNamespace(nameRaw);
    const size = registry?.itemsByName?.[name]?.stackSize;
    return typeof size === "number" && size > 0 ? size : 64;
  };
}
