// 备料系统 · 阶段2 — W1 任务 2.5：ResourceSourceMap 四层闸门 + 硬排除叶子可达性判定。
//
// 本文件填充任务 2.4 在 CraftPlanner 里预留的 LeafResolver 接缝（seam）：当 CraftPlanner
// 把某物品判为叶子（无可用配方或全部配方分支被环剪除）时，调用本 resolver 依
// requirements.md Requirement 3.7 / 4.1–4.7 与 design.md §4「四层闸门」判定可达性：
//
//   ① 第一层闸门：命中 data/unsupported-composite-items.json（23 条非叶子复合物）→ unreachable。
//   ② 第二层闸门：poolStatus 为 excluded / sealed → unreachable；active → 放行至第三层。
//   ③ 第三层闸门：active 但 supported=false 且带 substituteWith（stripped_* 系列）→ 依
//      substituteWith 重定向为未去皮同名物料继续判定（走 tag 等价路径）；下游配方硬编码写死
//      去皮物品名而无 tag 等价路径的 12 条 stripped_*_wood / *_hanging_sign 已由第一层闸门
//      （unsupported-composite-items）拦截判 unreachable。
//   ④ 第四层闸门：依 method 派执行器——
//        mine_underground / 方块类 harvest_biome → Collect_Executor
//        陆生动物 mob_drop                        → Combat_Executor
//        egg / milk_bucket 的 mob_interact         → Interact_Executor
//        farm_crop                                 → 一期 unreachable（D6）
//        其余（structure_loot / 无 method）        → unreachable
//
// 额外硬排除（Requirement 4.6 / 4.7，即便 poolStatus 为 active 也判 unreachable）：
//   - 钻石类 / 下界矿：diamond_ore、deepslate_diamond_ore、nether_gold_ore、
//     nether_quartz_ore、basalt → unreachable（category=excluded）。
//   - 怪物掉落与水生生物产物：bone、gunpowder、string、spider_eye、ender_pearl、
//     slime_ball、cod、salmon、ink_sac → unreachable（category=mob_or_aquatic_excluded）。
//
// 产物↔矿石块别名（Requirement 2.3 / 2.4）：像 coal / raw_iron / redstone / lapis_lazuli 等
// 「产物叶子」不直接出现于 resource-source-map.json（键是矿石方块），经 W0 对账生成的别名表
// 重定向到对应矿石方块采集；别名来源若命中硬排除矿（如 diamond→diamond_ore）同样判 unreachable。
//
// 规划真值源：以 recipes.json(1.21.4) 物品名（去 minecraft: 前缀归一化）为唯一真值源。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isValidStructureHarvestProfile } from "./structureHarvestProfile";

import { stripNamespace } from "./RecipeGraph";
import { ALIAS_TABLE_UNAVAILABLE_PREFIX, resolveOreAlias, type OreAliasSource } from "./ReconciliationCheck";
import type { LeafResolution, LeafResolver } from "./CraftPlanner";
import type { CollectMethod, CollectTool, ReasonCategory, StructureHarvestProfile } from "./types";

// ---------------------------------------------------------------------------
// 硬排除清单（Requirement 4.6 / 4.7）——即便 poolStatus 为 active 也判 unreachable
// ---------------------------------------------------------------------------

/** 4.6：钻石类 + 下界矿（即便 active 也不采）。 */
export const ORE_HARD_EXCLUDED: ReadonlySet<string> = new Set([
  "diamond_ore",
  "deepslate_diamond_ore",
  "ancient_debris",
  "nether_gold_ore",
  "nether_quartz_ore",
  "basalt",
  "smooth_basalt",
  "blackstone",
  "gilded_blackstone",
  "netherrack",
  "magma_block",
  "glowstone",
  "soul_sand",
  "soul_soil",
]);

const NETHER_BIOMES: ReadonlySet<string> = new Set([
  "nether_wastes",
  "soul_sand_valley",
  "crimson_forest",
  "warped_forest",
  "basalt_deltas",
]);

/**
 * 采集安全硬策略：禁止钻石矿与任何明确属于下界的自然来源。
 * 同时检查目标名、源方块和群系，避免 alias、旧映射或新增条目绕过单一名字清单。
 */
export function isForbiddenCollectSource(
  itemRaw: string,
  sourceBlockRaw?: string | null,
  biomes?: readonly string[] | null,
): boolean {
  const item = stripNamespace(itemRaw);
  const source = stripNamespace(sourceBlockRaw ?? itemRaw);
  if (ORE_HARD_EXCLUDED.has(item) || ORE_HARD_EXCLUDED.has(source)) return true;
  if (item.startsWith("nether_") || source.startsWith("nether_")) return true;
  return (biomes ?? []).some((raw) => NETHER_BIOMES.has(stripNamespace(raw)));
}

/** 4.7：一期不获取怪物掉落或水生生物产物。R5 移出 bone：骷髅夜间大量存在且 monster-guard
 * 已持续交战，bone→bone_meal 合成链是花类再生（bonemeal_grass）的关键供给。 */
export const MOB_AQUATIC_HARD_EXCLUDED: ReadonlySet<string> = new Set([
  "gunpowder",
  "string",
  "spider_eye",
  "ender_pearl",
  "slime_ball",
  "cod",
  "salmon",
  "ink_sac",
]);

/**
 * 生产 bots use protocol 1.21.4 against server 1.21.11. 保留空集合和规划闸门作为未来发生
 * 跨版本退化时的 fail-closed 接缝；原先因 1.21.4→1.21.11 ID 位移排除的花草现已放行复测。
 */
export const PROTOCOL_INCOMPATIBLE_ITEMS: ReadonlySet<string> = new Set();

// ---------------------------------------------------------------------------
// 第四层闸门 · method → 执行器分派
// ---------------------------------------------------------------------------

/** 可派发给某执行器的采集 method（reachable）。farm_crop 单独判不可达（D6）。 */
const DISPATCHABLE_METHODS: ReadonlySet<string> = new Set([
  "mine_underground", // → Collect_Executor
  "harvest_biome", // 方块类/花草 → Collect_Executor
  "bonemeal_grass", // 骨粉催生地表花草 → Collect_Executor（harvest_biome 的可再生变体）
  "harvest_structure", // 现场指纹验证后的结构资源堆 → Collect_Executor
  // 原木去皮 → Collect_Executor。它是**加工**而非采集：去皮原木既不自然生成也没有合成配方，
  // 唯一途径是对既有原木用斧头右键，所以执行器不扫描也不转场，在站内放置→去皮→砍下。
  // 基础原木由 withStripLogConsumable 注入为 inventoryUse，走既有 supply→buffer 搬运腿。
  "strip_log",
  "mob_drop", // 陆生动物白名单 → Combat_Executor（怪物/水生已被硬排除拦截）
  "mob_interact", // egg / milk_bucket → Interact_Executor
]);

// ---------------------------------------------------------------------------
// resource-source-map.json 条目形状（读取所需字段）
// ---------------------------------------------------------------------------

interface ResourceSourceEntry {
  itemName?: string;
  supported?: boolean;
  method?: string | null;
  mobName?: string | null;
  biomes?: string[] | null;
  yRangeMin?: number | null;
  yRangeMax?: number | null;
  poolStatus?: string | null;
  substituteWith?: string | null;
  structureProfile?: StructureHarvestProfile | null;
  tool?: {
    hasBlockForm?: boolean;
    sourceBlock?: string | null;
    material?: string | null;
    harvestTools?: string[] | null;
  } | null;
}

interface ResourceSourceMap {
  entries?: Record<string, ResourceSourceEntry>;
}

interface CompositeItemsFile {
  unsupportedItems?: Array<{ item?: string }>;
}

/** recipes.json 顶层（本模块仅用 recipesByResult，用于派生「无熔炉中间产物」集合）。 */
interface RawRecipesForFurnace {
  recipesByResult?: Record<string, Array<{ type?: string; result?: { item?: string; name?: string } }>>;
}

/**
 * 被过滤掉的「熔炉/烟熏/营火」冶炼配方类型（Requirement 5.5 的「无熔炉中间产物」判定用）。
 * 一件物品若仅作为这些配方类型的产物出现（如 iron_ingot / glass / charcoal），且不可直接采集、
 * 无可用 shaped/shapeless 采集路径，则其不可达原因归类为「无熔炉中间产物」。
 */
const FURNACE_RECIPE_TYPES: ReadonlySet<string> = new Set([
  "smelting",
  "blasting",
  "smoking",
  "campfire_cooking",
]);

// ---------------------------------------------------------------------------
// 数据文件加载（带缓存）
// ---------------------------------------------------------------------------

function dataDir(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  // src/core/preparation → 向上 3 级到 src-api，data/ 在其下。
  return path.resolve(__dirname, "../../../data");
}

function readJson<T>(filePath: string): T | null {
  try {
    const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export interface FourGateOptions {
  /** 覆盖 resource-source-map.json 的 entries（测试注入）。 */
  resourceMap?: Record<string, ResourceSourceEntry>;
  /** 覆盖 unsupported-composite-items 清单（测试注入，条目为物品名字符串）。 */
  compositeItems?: Iterable<string>;
  /** 覆盖产物↔矿石块别名解析（测试注入）；默认用 ReconciliationCheck.resolveOreAlias。 */
  resolveAlias?: (product: string) => { sources: OreAliasSource[] } | null;
  /**
   * 覆盖「无熔炉中间产物」集合（测试注入，条目为物品名字符串）；
   * 默认从项目根 recipes.json 派生（仅作为 smelting/blasting/smoking/campfire_cooking 产物的物品）。
   */
  furnaceIntermediates?: Iterable<string>;
}

// 进程级缓存（默认路径）。
let cachedResourceMap: Record<string, ResourceSourceEntry> | null = null;
let cachedComposite: Set<string> | null = null;
let cachedFurnace: Set<string> | null = null;

function loadResourceMap(): Record<string, ResourceSourceEntry> {
  if (cachedResourceMap) return cachedResourceMap;
  const parsed = readJson<ResourceSourceMap>(path.join(dataDir(), "resource-source-map.json"));
  cachedResourceMap = parsed?.entries ?? {};
  return cachedResourceMap;
}

/**
 * 骨粉催生花草表（data/bonemeal-flora-map.json）。
 *
 * 为什么需要它：天然花丛是**一次性资源**。真服连跑 30+ 单后基地周边的蒲公英被采空，
 * 后续订单只能越飞越远，实测落地 `scanned=0`（连已验证锚点所在的 sunflower_plains 也扫不到）。
 * 对草方块用骨粉可以就地再生，把花类备料从一次性变成可再生。
 *
 * 只覆盖 wiki 明确记载「骨粉可在草方块上催生」的小花与草；两格高花（丁香/牡丹/玫瑰丛/向日葵）
 * 催不出来，不在表内。命中本表的物品把 method 改为 bonemeal_grass，并用表里的群系覆盖资源表的
 * biomes —— 后者是「哪里天然长」，前者是「哪里催得出」，两者并不相同（例如 flower_forest 天然
 * 有蒲公英分布记载，但骨粉在 flower_forest 催不出蒲公英）。
 */
let cachedBonemealFlora: BonemealFloraMap | null = null;

interface BonemealFloraProduct {
  biomes?: string[] | null;
  excludedBiomes?: string[] | null;
  requiresShears?: boolean;
  preferNaturalHarvest?: boolean;
}
interface BonemealFloraMap {
  requirements?: { targetBlock?: string; minLightLevel?: number; spreadRadius?: number };
  products?: Record<string, BonemealFloraProduct>;
}

function loadBonemealFlora(): BonemealFloraMap {
  if (cachedBonemealFlora) return cachedBonemealFlora;
  const parsed = readJson<BonemealFloraMap>(path.join(dataDir(), "bonemeal-flora-map.json"));
  cachedBonemealFlora = parsed ?? {};
  return cachedBonemealFlora;
}

/** 该物品是否可由骨粉催生（并返回催生群系）。返回 null 表示不可催生。 */
export function bonemealFloraFor(
  item: string,
  override?: BonemealFloraMap | null,
): { biomes: string[]; requiresShears: boolean } | null {
  const map = override ?? loadBonemealFlora();
  const entry = map.products?.[stripNamespace(item)];
  if (!entry || entry.preferNaturalHarvest === true) return null;
  const biomes = (entry.biomes ?? []).filter((b) => typeof b === "string" && b);
  if (biomes.length === 0) return null;
  return { biomes, requiresShears: entry.requiresShears === true };
}

function loadCompositeSet(): Set<string> {
  if (cachedComposite) return cachedComposite;
  const parsed = readJson<CompositeItemsFile>(
    path.join(dataDir(), "unsupported-composite-items.json"),
  );
  const set = new Set<string>();
  for (const it of parsed?.unsupportedItems ?? []) {
    if (it?.item) set.add(stripNamespace(it.item));
  }
  cachedComposite = set;
  return set;
}

/** 项目根 recipes.json 路径（LeafResolver.ts 位于 src/core/preparation，向上 5 级到项目根）。 */
function projectRootRecipesPath(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const SRC_API_DIR = path.resolve(__dirname, "..", "..", ".."); // → src-api
  const PROJECT_ROOT = path.resolve(SRC_API_DIR, "..", ".."); // → 项目根
  return path.join(PROJECT_ROOT, "recipes.json");
}

/**
 * 从项目根 recipes.json 派生「无熔炉中间产物」集合（Requirement 5.5）：
 * 收集所有作为 smelting/blasting/smoking/campfire_cooking 配方产物出现的物品名。
 * 这些物品（如 iron_ingot / glass / charcoal / gold_ingot / smooth_stone / 熟食）在一期无熔炉下
 * 只能靠冶炼获得——当它们落为不可达叶子（不在 ResourceSourceMap、无产物↔矿石别名）时，
 * 其不可达原因归类为「无熔炉中间产物」，而非泛化的「超出采集范围」。
 */
function loadFurnaceIntermediateSet(): Set<string> {
  if (cachedFurnace) return cachedFurnace;
  const parsed = readJson<RawRecipesForFurnace>(projectRootRecipesPath());
  const set = new Set<string>();
  const byResult = parsed?.recipesByResult ?? {};
  for (const [key, list] of Object.entries(byResult)) {
    if (!Array.isArray(list)) continue;
    for (const rec of list) {
      if (rec?.type && FURNACE_RECIPE_TYPES.has(rec.type)) {
        const name = stripNamespace(rec.result?.item ?? rec.result?.name ?? key);
        if (name) set.add(name);
      }
    }
  }
  cachedFurnace = set;
  return set;
}

/** 仅供测试：清除默认数据文件缓存。 */
export function resetLeafResolverCacheForTest(): void {
  cachedResourceMap = null;
  cachedComposite = null;
  cachedFurnace = null;
}

// ---------------------------------------------------------------------------
// 构造结果的小工具
// ---------------------------------------------------------------------------

function unreachable(reason: string, category: ReasonCategory): LeafResolution {
  return { reachable: false, unreachable: { reason, category } };
}

function reachable(gap: NonNullable<LeafResolution["gap"]>): LeafResolution {
  return { reachable: true, gap };
}

function toolFromEntry(entry: ResourceSourceEntry): CollectTool | null {
  if (!entry.tool) return null;
  return {
    hasBlockForm: Boolean(entry.tool.hasBlockForm),
    sourceBlock: entry.tool.sourceBlock ?? null,
    material: entry.tool.material ?? "default",
    harvestTools: entry.tool.harvestTools ?? null,
  };
}

function gapFromEntry(item: string, entry: ResourceSourceEntry): NonNullable<LeafResolution["gap"]> {
  const tool = toolFromEntry(entry);
  const baseMethod = (entry.method as CollectMethod) ?? "harvest_biome";
  // 骨粉可催生的花草改走 bonemeal_grass：天然花丛采一次就没了（真服实测周边采空后
  // 落地 scanned=0），而催生是可再生的。群系必须用催花表的（"哪里催得出"），
  // 不能用资源表的（"哪里天然长"）—— 两者不同，例如骨粉在 flower_forest 催不出蒲公英。
  const flora = baseMethod === "harvest_biome" ? bonemealFloraFor(item) : null;
  if (flora) {
    return {
      method: "bonemeal_grass" as CollectMethod,
      tool,
      sourceBlock: entry.tool?.sourceBlock ?? stripNamespace(item),
      biomes: flora.biomes,
      yRange: { min: entry.yRangeMin ?? null, max: entry.yRangeMax ?? null },
      mobName: null,
    };
  }
  return {
    method: baseMethod,
    tool,
    sourceBlock: entry.tool?.sourceBlock ?? null,
    biomes: entry.biomes ?? null,
    yRange: { min: entry.yRangeMin ?? null, max: entry.yRangeMax ?? null },
    // mob_drop 时携带掉落生物名（beef→cow）供 collect_hunt 的 animals=[mobName]。
    mobName: entry.mobName ?? null,
    structureProfile: entry.structureProfile ?? null,
  };
}

function gapFromAliasSource(src: OreAliasSource): NonNullable<LeafResolution["gap"]> {
  return {
    method: (src.method as CollectMethod) ?? "mine_underground",
    tool: src.tool ?? null,
    sourceBlock: src.sourceBlock ?? src.tool?.sourceBlock ?? null,
    biomes: src.biomes ?? null,
    yRange: src.yRange ?? { min: null, max: null },
    // 别名来源均为矿石方块（mine_underground），无掉落生物。
    mobName: null,
  };
}

// ---------------------------------------------------------------------------
// 四层闸门 + 硬排除主判定
// ---------------------------------------------------------------------------

/**
 * 创建完整的「四层闸门 + 硬排除」叶子判定接缝。
 * CraftPlanner 默认使用本实现（见 CraftPlanner 构造器）。
 */
export function createFourGateLeafResolver(options: FourGateOptions = {}): LeafResolver {
  const resourceMap = options.resourceMap ?? null;
  const compositeSet = options.compositeItems ? new Set([...options.compositeItems]) : null;
  // 别名表读取失败不再吞掉：调用点据此上报明确原因，不伪装成「无采集来源」。
  const resolveAlias = options.resolveAlias ?? ((product: string) => resolveOreAlias(product));

  const furnaceSet = options.furnaceIntermediates ? new Set([...options.furnaceIntermediates]) : null;

  const getMap = (): Record<string, ResourceSourceEntry> => resourceMap ?? loadResourceMap();
  const getComposite = (): Set<string> => compositeSet ?? loadCompositeSet();
  const getFurnace = (): Set<string> => furnaceSet ?? loadFurnaceIntermediateSet();

  const resolveInternal = (itemRaw: string, visited: Set<string>): LeafResolution => {
    const item = stripNamespace(itemRaw);

    // 白羊毛既能由 4 根线合成，也会由未剪毛白羊在死亡时直接掉落。资源表只记录了
    // mutton→sheep，漏掉了同一实体的 wool 掉落，导致库存不足时规划器只能走残缺的
    // 染色配方。Combat_Executor 已支持 sheep，并按任务目标的真实入包增量计数；把该
    // 原版掉落补成直接叶子后，规划器会优先真实猎取缺口，不再凭染料虚构羊毛。
    if (item === "white_wool") {
      return reachable({
        method: "mob_drop",
        tool: null,
        sourceBlock: null,
        biomes: null,
        yRange: { min: null, max: null },
        mobName: "sheep",
      });
    }

    // 牛会直接掉落皮革。缺少这条叶子路径时，规划器会选择四张兔皮合成一张皮革，
    // 将普通皮革订单错误地放大为稀有兔子搜索任务。
    if (item === "leather") {
      return reachable({
        method: "mob_drop",
        tool: null,
        sourceBlock: null,
        biomes: null,
        yRange: { min: null, max: null },
        mobName: "cow",
      });
    }

    if (PROTOCOL_INCOMPATIBLE_ITEMS.has(item)) {
      return unreachable(
        `protocol_version_incompatible: bot=1.21.4 server=1.21.11 item=${item}`,
        "excluded",
      );
    }

    // 防重定向环（stripped_* → substituteWith）。
    if (visited.has(item)) {
      return unreachable(`重定向出现环（${item}），无采集路径`, "out_of_collect_range");
    }

    // ── 第一层闸门：非叶子复合物清单（23 条）───────────────────────────────
    if (getComposite().has(item)) {
      return unreachable(
        `命中 unsupported-composite-items 清单（非叶子复合物，硬编码依赖去皮原木/菌柄，无 tag 等价路径）`,
        "out_of_collect_range",
      );
    }

    const entry = getMap()[item];

    // ── 硬排除（钻石矿 + 任意明确下界来源）────────────────────────────────
    // 同时检查 item/sourceBlock/biomes，防止 alias、新映射或旧任务只绕开其中一个字段。
    if (isForbiddenCollectSource(item, entry?.tool?.sourceBlock, entry?.biomes)) {
      return unreachable(`硬排除：钻石矿或下界来源（${item}）不采集`, "excluded");
    }
    if (MOB_AQUATIC_HARD_EXCLUDED.has(item)) {
      return unreachable(`硬排除：怪物掉落/水生生物产物（${item}）一期不获取`, "mob_or_aquatic_excluded");
    }

    if (entry) {
      // ── 第二层闸门：poolStatus ─────────────────────────────────────────
      const pool = entry.poolStatus;
      if (pool === "excluded") {
        return unreachable(`poolStatus=excluded（T3 排除项）`, "excluded");
      }
      if (pool === "sealed") {
        return unreachable(`poolStatus=sealed（T1/T2 封存 tier，一期不做）`, "sealed_tier");
      }
      if (pool !== "active") {
        return unreachable(`poolStatus=${pool ?? "missing"}，仅显式 active 条目可派发`, "out_of_collect_range");
      }
      // 仅 active 放行至第三层。

      // ── 第三层闸门：stripped_* 的 substituteWith 重定向 ─────────────────
      if (entry.supported === false) {
        if (entry.substituteWith) {
          // 走 tag 等价路径：重定向为未去皮同名物料继续判定。
          const next = new Set(visited);
          next.add(item);
          return resolveInternal(entry.substituteWith, next);
        }
        // supported=false 且无 substituteWith：无采集路径。
        return unreachable(`标记为不支持采集且无 substituteWith 重定向路径`, "out_of_collect_range");
      }

      // ── 第四层闸门：method → 执行器分派 ───────────────────────────────
      const method = entry.method ?? null;
      if (method === "farm_crop") {
        return unreachable(`method=farm_crop（种田一期不做）`, "out_of_collect_range");
      }
      if (method === "harvest_structure" && !isValidStructureHarvestProfile(
        entry.structureProfile,
        entry.tool?.sourceBlock ?? item,
      )) {
        return unreachable(`method=harvest_structure 的 structureProfile 无效，拒绝派发`, "out_of_collect_range");
      }
      if (method && DISPATCHABLE_METHODS.has(method)) {
        return reachable(gapFromEntry(item, entry));
      }
      // structure_loot / null / 未知 method → 无采集执行器。
      return unreachable(
        `method=${method ?? "null"} 无对应采集执行器`,
        "out_of_collect_range",
      );
    }

    // ── 无直接映射条目：尝试产物↔矿石块别名（Requirement 2.3 / 2.4）──────────
    let alias: { sources: OreAliasSource[] } | null;
    try {
      alias = resolveAlias(item);
    } catch (error) {
      // 别名表读取失败必须如实上报：伪装成「无采集来源」会把数据问题指向错误的排查方向。
      const message = error instanceof Error ? error.message : String(error);
      return unreachable(`${ALIAS_TABLE_UNAVAILABLE_PREFIX}: ${message}`, "out_of_collect_range");
    }
    if (alias && alias.sources.length > 0) {
      // 别名来源也必须经过同一硬策略，避免 diamond→diamond_ore、quartz→nether_quartz_ore
      // 或未来新增下界别名绕过直接条目判定。
      const usable = alias.sources.filter(
        (s) => !isForbiddenCollectSource(
          item,
          s.sourceBlock ?? s.sourceMapKey ?? s.tool?.sourceBlock,
          s.biomes,
        ),
      );
      if (usable.length === 0) {
        return unreachable(`硬排除：唯一矿石来源被排除（${item}）`, "excluded");
      }
      // 别名来源亦须过 poolStatus（排除/封存的矿石来源不放行）。
      const active = usable.filter((s) => s.poolStatus === "active");
      const pick = active[0] ?? null;
      if (!pick) {
        const anySealed = usable.some((s) => s.poolStatus === "sealed");
        return unreachable(
          `矿石来源 poolStatus 非 active（${item}）`,
          anySealed ? "sealed_tier" : "excluded",
        );
      }
      return reachable(gapFromAliasSource(pick));
    }

    // 无配方、无映射、无别名 → 无采集来源。
    // Requirement 5.5：若该叶子是「仅由冶炼产出」的中间产物（iron_ingot / glass / charcoal 等），
    // 一期无熔炉且库存无法反拆得到 → 归类为「无熔炉中间产物」。
    if (getFurnace().has(item)) {
      return unreachable(
        `无熔炉中间产物：${item} 仅可由冶炼（smelting/blasting）产出，一期无熔炉且库存无法反拆得到`,
        "no_furnace_intermediate",
      );
    }
    return unreachable(`无可用配方且无采集来源（不在 ResourceSourceMap，无产物↔矿石别名）`, "out_of_collect_range");
  };

  return {
    resolve(itemRaw: string): LeafResolution {
      return resolveInternal(itemRaw, new Set<string>());
    },
  };
}
