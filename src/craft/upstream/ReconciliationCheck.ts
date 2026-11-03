// 备料系统 · 阶段2 — W0 对账组件的 TypeScript 消费侧（任务 1.3）。
// 依据 .kiro/specs/material-preparation-phase2/design.md §3.3 与 requirements.md
// Requirement 2.3 / 2.4 / 2.5：
//   2.3  对"映射表以矿石方块为叶子、而配方要求对应产物"的错位，生成产物↔矿石块别名条目
//        供 Craft_Planner 使用。
//   2.4  Craft_Planner 以 recipes.json 的物品名为规划真值源（product），而非
//        minecraft-data 的 itemsByName。
//   2.5  IF 对账报告存在未定夺的错位条目，THEN 阻断后续采集与合成功能，直至对账通过。
//
// 别名表数据由 scripts/reconcile-resource-map.mjs 在 W0 对账时生成并落盘到
//   data/resource-source-map.alias.json
// 本模块只做"加载 + 类型化 + 阻断查询"，不重复实现别名生成逻辑（生成逻辑是脚本里的
// 纯函数 buildOreProductAliases / determineBlocking / buildAliasTable，可离线复用）。
//
// 路径约定：与其它 store 一致——ReconciliationCheck.ts 位于 src/core/preparation，
// 向上 3 级到 src-api 根，读取 src-api/data/resource-source-map.alias.json。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { CollectMethod, CollectTool, YRange } from "./types";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** 默认别名表数据文件（W0 对账脚本产出）。 */
export const DEFAULT_ALIAS_FILE = path.join(
  __dirname,
  "../../../data/resource-source-map.alias.json",
);

/**
 * 别名表读不出来时上报的不可达原因前缀。
 * 这是「数据文件没准备好」，与「该物品真的没有采集来源」是两回事：把前者静默降级成后者，
 * 会让整批订单顶着「超出采集范围」被拒，运维照着这个理由永远查不到真正的原因。
 */
export const ALIAS_TABLE_UNAVAILABLE_PREFIX = "矿物别名表不可用（请先运行 W0 对账 npm run reconcile）";

// ---------------------------------------------------------------------------
// 类型（与 scripts/reconcile-resource-map.mjs 的落盘结构对齐）
// ---------------------------------------------------------------------------

/** 一个产物在某矿石方块处的采集来源（含挖掘元信息）。 */
export interface OreAliasSource {
  /** 该来源在 resource-source-map.json 中的 key（矿石方块名）。 */
  sourceMapKey: string;
  /** 破坏以获得该产物的源方块名。 */
  sourceBlock: string;
  /** 采集方式（一般为 mine_underground）。 */
  method: CollectMethod | null;
  /** 目标群系集合；无约束为 null。 */
  biomes: string[] | null;
  /** 采集 Y 高度区间。 */
  yRange: YRange;
  /** 采集工具描述（材质/harvestTools）。 */
  tool: CollectTool | null;
  /** 该矿石块的池状态（active/sealed/excluded）；四层闸门据此判定。 */
  poolStatus: string | null;
}

/**
 * 产物↔矿石块别名条目（Requirement 2.3）。
 * 例：coal → { sources: [coal_ore, deepslate_coal_ore] }；
 *     raw_iron → { sources: [iron_ore, deepslate_iron_ore] }。
 * product 即 recipes.json 的物品名（规划真值源，Requirement 2.4）。
 */
export interface OreProductAlias {
  /** 采集产物名（recipes.json 物品名）。 */
  product: string;
  /** 该产物可采集的矿石方块来源集合（含主世界 + deepslate 变种）。 */
  sources: OreAliasSource[];
}

/** 一条已定夺的错位记录（叶子或映射表 key）及其定夺依据。 */
export interface DeterminedMismatch {
  name: string;
  mismatch: "leaf_not_in_map" | "map_key_not_in_input" | string;
  resolution: {
    by: "ore_alias" | "no_furnace_intermediate" | "map_superset_unused" | string;
    detail: string;
  };
}

/** 一条未定夺的错位记录（触发阻断）。 */
export interface UndeterminedMismatch {
  name: string;
  mismatch: "leaf_not_in_map" | "map_key_not_in_input" | string;
}

/** 阻断判定结果（Requirement 2.5）。 */
export interface BlockingReport {
  /** 是否存在未定夺错位 → 阻断后续采集与合成功能。 */
  blocked: boolean;
  /** 未定夺错位条目（需补映射表/扩展别名后方可解除阻断）。 */
  undetermined: UndeterminedMismatch[];
  /** 已定夺的叶子错位。 */
  determinedLeaves: DeterminedMismatch[];
  /** 已定夺的映射表 key 错位。 */
  determinedMapKeys: DeterminedMismatch[];
}

/** 别名表完整结构（落盘 JSON 顶层）。 */
export interface AliasTable {
  meta?: Record<string, unknown>;
  /** product → OreProductAlias。 */
  aliases: Record<string, OreProductAlias>;
  /** 阻断判定。 */
  blocking: BlockingReport;
}

/**
 * 对账未通过（存在未定夺错位）时抛出，供服务端启动路径据此拒绝启用 preparation 功能。
 */
export class ReconciliationBlockedError extends Error {
  readonly undetermined: UndeterminedMismatch[];

  constructor(undetermined: UndeterminedMismatch[]) {
    const names = undetermined.map((u) => u.name).join(", ");
    super(`W0 对账存在未定夺错位，preparation 功能被阻断: ${names}`);
    this.name = "ReconciliationBlockedError";
    this.undetermined = undetermined;
  }
}

// ---------------------------------------------------------------------------
// 加载与缓存
// ---------------------------------------------------------------------------

let cached: AliasTable | null = null;
let cachedPath: string | null = null;

/**
 * 加载别名表（默认从 data/resource-source-map.alias.json）。
 * 首次加载后缓存；传入不同 filePath 会重新加载。
 *
 * @throws 当文件缺失或 JSON 结构非法时抛出（缺失即视为 W0 对账尚未运行，属阻断态）。
 */
export function loadAliasTable(filePath: string = DEFAULT_ALIAS_FILE): AliasTable {
  if (cached && cachedPath === filePath) {
    return cached;
  }

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (error) {
    throw new Error(
      `无法读取别名表 ${filePath}（请先运行 W0 对账: npm run reconcile）: ${
        (error as Error)?.message ?? String(error)
      }`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`别名表 ${filePath} JSON 解析失败: ${(error as Error)?.message ?? String(error)}`);
  }

  const table = normalizeAliasTable(parsed);
  cached = table;
  cachedPath = filePath;
  return table;
}

/**
 * 解析某产物的矿石块采集别名（Requirement 2.3 / 2.4）。
 * CraftPlanner 在把某物品判为叶子时调用：命中则说明该"产物叶子"可由挖对应矿石方块获得。
 *
 * @param product recipes.json 的产物物品名（真值源）。
 * @returns 别名条目；未命中返回 null。
 */
export function resolveOreAlias(
  product: string,
  filePath: string = DEFAULT_ALIAS_FILE,
): OreProductAlias | null {
  const table = loadAliasTable(filePath);
  return table.aliases[product] ?? null;
}

/** 判断某产物是否可经矿石块采集别名获得。 */
export function isProductCollectableViaOre(
  product: string,
  filePath: string = DEFAULT_ALIAS_FILE,
): boolean {
  return resolveOreAlias(product, filePath) !== null;
}

/**
 * preparation 功能是否被 W0 对账阻断（Requirement 2.5）。
 * CraftPlanner / 启动路径据此在对账通过前拒绝启用采集与合成。
 * 别名表缺失或读取失败也视为阻断（尚未完成对账）。
 */
export function isPreparationBlocked(filePath: string = DEFAULT_ALIAS_FILE): boolean {
  try {
    return loadAliasTable(filePath).blocking.blocked;
  } catch {
    return true;
  }
}

/** 返回阻断判定详情（含未定夺条目）；文件缺失时返回一个 blocked=true 的兜底报告。 */
export function getBlockingReport(filePath: string = DEFAULT_ALIAS_FILE): BlockingReport {
  try {
    return loadAliasTable(filePath).blocking;
  } catch {
    return { blocked: true, undetermined: [], determinedLeaves: [], determinedMapKeys: [] };
  }
}

/**
 * 断言 W0 对账已通过；存在未定夺错位则抛出 {@link ReconciliationBlockedError}。
 * 供服务端启动路径调用，对账未通过时拒绝启用 preparation 功能（Requirement 2.5）。
 */
export function assertReconciliationPassed(filePath: string = DEFAULT_ALIAS_FILE): void {
  const report = getBlockingReport(filePath);
  if (report.blocked) {
    throw new ReconciliationBlockedError(report.undetermined);
  }
}

/** 仅供测试：清除缓存，使下次 loadAliasTable 重新读文件。 */
export function resetAliasCacheForTest(): void {
  cached = null;
  cachedPath = null;
}

// ---------------------------------------------------------------------------
// 内部：结构归一化 / 校验
// ---------------------------------------------------------------------------

function normalizeAliasTable(parsed: unknown): AliasTable {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("别名表结构非法：顶层不是对象");
  }
  const obj = parsed as Record<string, unknown>;
  const aliases = (obj.aliases ?? {}) as Record<string, OreProductAlias>;
  const blockingRaw = (obj.blocking ?? {}) as Partial<BlockingReport>;

  if (typeof aliases !== "object") {
    throw new Error("别名表结构非法：aliases 不是对象");
  }

  const blocking: BlockingReport = {
    blocked: Boolean(blockingRaw.blocked),
    undetermined: Array.isArray(blockingRaw.undetermined) ? blockingRaw.undetermined : [],
    determinedLeaves: Array.isArray(blockingRaw.determinedLeaves) ? blockingRaw.determinedLeaves : [],
    determinedMapKeys: Array.isArray(blockingRaw.determinedMapKeys)
      ? blockingRaw.determinedMapKeys
      : [],
  };

  return {
    meta: (obj.meta as Record<string, unknown>) ?? undefined,
    aliases,
    blocking,
  };
}
