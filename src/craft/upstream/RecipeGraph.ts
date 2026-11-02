// 备料系统 · 阶段2 — W1 自研合成引擎 RecipeGraph（离线可单测）。
// 依据 design.md §3.1 与 requirements.md Requirement 1.1–1.5：
//   1.1 服务端启动，从项目根 recipes.json(1.21.4) 读入配方数据，建立
//       recipesByResult[产物名] → UsableRecipe[] 索引。
//   1.2 仅保留 shaped / shapeless；加载期过滤 smelting/blasting/campfire_cooking/
//       smoking/stonecutting/smithing_transform/transmute/special/decorated_pot。
//   1.3 归一化为「含产物名与数量的结果」+「每个输入的候选物品名集合与所需数量」。
//   1.4 输入以 tag 给出时展开为候选物品名集合（含 recipes.json 的嵌套 tag，递归 + 环剪除），
//       候选集合中任一物品可得即视为满足（对齐 MC tag 语义）。
//   1.5 使用 minecraft-data 的 1.21.4 registry 校验/归一化；无法提供 1.21.4 registry 时
//       拒绝启动并记录版本不匹配错误（由 versionGuard.loadMcRegistry() 抛 VersionMismatchError）。
//
// 规划真值源：recipes.json(1.21.4) 的物品名（去 minecraft: 前缀归一化）为唯一真值源；
// registry 仅用于名称校验（剔除 registry 未知的名称并记日志）。实测 1.21.4 下
// shaped/shapeless 的所有产物名与输入候选名均在 registry 内，故正常情况下不会剔除任何名称。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { McRegistry } from "./versionGuard";
import { loadMcRegistry } from "./versionGuard";
import type { RecipeInput, RecipeResult, UsableRecipe, UsableRecipeType } from "./types";

// ---------------------------------------------------------------------------
// 常量：可用 / 过滤配方类型（Requirement 1.2 / design.md §3.1）
// ---------------------------------------------------------------------------

/** 可用配方类型：只有这两种进入 RecipeGraph（其余加载期过滤）。 */
export const USABLE_RECIPE_TYPES: ReadonlySet<UsableRecipeType> = new Set<UsableRecipeType>([
  "shaped",
  "shapeless",
]);

// ---------------------------------------------------------------------------
// 候选原料的「可执行性」收窄
// ---------------------------------------------------------------------------
//
// recipes.json 按 vanilla 物品 tag 展开原料，这在游戏里是对的：`oak_planks` 的原料是
// `#oak_logs`，oak_log / oak_wood / stripped_oak_log / stripped_oak_wood 四个都能用。
//
// 但 **bot 端合不出来**。执行器最终调用 `bot.recipesFor(产物id, ...)`，那份表来自
// minecraft-data，而 minecraft-data 1.21.4 里 `oak_planks` 只有一条配方、原料只认
// `oak_log`（id 134），另外三个变体（148/159/171）压根没编码。
//
// 后果是「规划器认为库里有料 → 接单 → bot 取到 stripped_oak_log → recipesFor 返回空 →
// recipe_unavailable」。真服 cyc76/cyc83 连续命中：仓库里只剩 stripped_oak_log×7、
// oak_log=0，于是**所有需要木板的订单**（oak_stairs / chest / …）全部接单后失败。
//
// 所以规划期就必须按执行器的真实能力收窄：只保留 minecraft-data 配方表里真的编码过的变体。
// 这样订单要么用一个 bot 真能用的原料，要么在下单闸门就如实报「缺料」，不再"接了再死"。
// 判不出来时**返回原候选集**（fail-open）：minecraft-data 缺该产物配方（例如只能靠
// 熔炉/切石机得到，或 recipes.json 比 minecraft-data 新）时保持原行为，绝不因为查不到就把
// 本来能做的单判死。
let executableIngredientCache: Map<string, ReadonlySet<string>> | null = null;

/** 惰性构建「产物名 → minecraft-data 配方里真实出现过的原料名集合」。 */
function executableIngredientIndex(): Map<string, ReadonlySet<string>> {
  if (executableIngredientCache) return executableIngredientCache;
  const index = new Map<string, ReadonlySet<string>>();
  try {
    const registry = loadMcRegistry() as McRegistry & {
      recipes?: Record<string, Array<Record<string, unknown>>>;
      items?: Record<string, { name?: string }>;
    };
    const recipes = registry.recipes ?? {};
    const items = registry.items ?? {};
    const nameOf = (id: unknown): string => {
      const item = items[String(id)];
      return item && typeof item.name === "string" ? stripNamespace(item.name) : "";
    };
    for (const [resultId, list] of Object.entries(recipes)) {
      const resultName = nameOf(resultId);
      if (!resultName || !Array.isArray(list)) continue;
      const ingredients = new Set<string>(index.get(resultName) ?? []);
      for (const recipe of list) {
        const raw: unknown[] = [];
        const ing = (recipe as { ingredients?: unknown }).ingredients;
        if (Array.isArray(ing)) raw.push(...ing);
        const shape = (recipe as { inShape?: unknown }).inShape;
        if (Array.isArray(shape)) {
          for (const row of shape) if (Array.isArray(row)) raw.push(...row);
        }
        for (const entry of raw) {
          if (entry == null) continue;
          const id = (typeof entry === "object") ? (entry as { id?: unknown }).id : entry;
          if (id == null || id === -1) continue;
          const name = nameOf(id);
          if (name) ingredients.add(name);
        }
      }
      if (ingredients.size > 0) index.set(resultName, ingredients);
    }
  } catch {
    // registry 不可用时留空索引 → 所有收窄都 fail-open，行为与改动前一致。
  }
  executableIngredientCache = index;
  return index;
}

/**
 * 把某产物的一个原料候选集收窄为「bot 端配方表真能用」的子集（纯逻辑，供单测）。
 * 交集为空或无从判断时返回原候选集（fail-open，理由见上方注释）。
 */
export function narrowToExecutableNames(resultName: string, candidateNames: string[]): string[] {
  if (candidateNames.length <= 1) return candidateNames;
  const encodable = executableIngredientIndex().get(stripNamespace(resultName));
  if (!encodable || encodable.size === 0) return candidateNames;
  const usable = candidateNames.filter((name) => encodable.has(name));
  return usable.length > 0 ? usable : candidateNames;
}

/** 测试辅助：清空可执行原料索引缓存。 */
export function resetExecutableIngredientCache(): void {
  executableIngredientCache = null;
}

/**
 * recipes.json 的 1.21.4 转换器把 `crafting_transmute` 羊毛染色配方降级为
 * shapeless 时只保留了 material（染料），漏掉 input（被染色羊毛）。mineflayer
 * 实际执行仍使用 minecraft-data 的完整两原料配方；不补全会让规划器凭一份染料
 * 凭空规划出一份羊毛，直到真服 craft 阶段才以 recipe_unavailable 失败。
 *
 * minecraft-data 把 wool tag 具体化为一个稳定代表物：除 black_wool 外均使用
 * black_wool，black_wool 使用 blue_wool。这里严格补成执行器真实接受的输入，
 * 避免再次出现“规划可行、执行无配方”。
 */
export function completeKnownRecipeInputs(recipe: UsableRecipe): UsableRecipe {
  const resultName = stripNamespace(recipe.result.name);
  const expectedDye = resultName.replace(/_wool$/, "_dye");
  const isIncompleteDyeWool = /^dye_.+_wool$/.test(recipe.id)
    && /_wool$/.test(resultName)
    && recipe.inputs.length === 1
    && recipe.inputs[0].count === 1
    && recipe.inputs[0].names.length === 1
    && recipe.inputs[0].names[0] === expectedDye;
  if (!isIncompleteDyeWool) return recipe;

  const baseWool = resultName === "black_wool" ? "blue_wool" : "black_wool";
  return {
    ...recipe,
    inputs: [...recipe.inputs, { names: [baseWool], count: 1 }],
  };
}

/**
 * 加载期过滤掉的配方类型（Requirement 1.2）。
 * transmute 依据 requirements.md/types.ts 归入过滤集（一期不做 transmute）。
 */
export const FILTERED_RECIPE_TYPES: ReadonlySet<string> = new Set([
  "smelting",
  "blasting",
  "campfire_cooking",
  "smoking",
  "stonecutting",
  "smithing_transform",
  "transmute",
  "special",
  "decorated_pot",
]);

// ---------------------------------------------------------------------------
// recipes.json 的原始形态（仅声明本模块用到的字段）
// ---------------------------------------------------------------------------

/** ingredient slot：null（空格） | {item} | {tag,items} | {tag}。 */
type RawSlot = { item?: string; tag?: string; items?: string[] } | null;

interface RawRecipe {
  type: string;
  /** shaped 用：二维格子。 */
  pattern?: RawSlot[][];
  /** shapeless 用：输入列表。 */
  ingredients?: RawSlot[];
  /** smelting/stonecutting 等单输入形态（本模块不处理，仅为类型完整性）。 */
  ingredient?: RawSlot;
  result?: { item?: string; name?: string; count?: number };
  /** 该配方对应的数据包文件名（如 iron_ingot_from_iron_block.json），用作稳定 id。 */
  file?: string;
  group?: string;
}

interface RawRecipesJson {
  meta?: { version?: string };
  /** tag 名（含或不含 minecraft: 前缀） → 成员数组（成员可为物品名或嵌套 #tag 引用）。 */
  tags?: Record<string, string[]>;
  /** 产物名（含 minecraft: 前缀） → 该产物的原始配方列表。 */
  recipesByResult?: Record<string, RawRecipe[]>;
}

// ---------------------------------------------------------------------------
// 名称归一化
// ---------------------------------------------------------------------------

/** 去掉前导 `#` 与 `minecraft:`（或任意 namespace:）前缀，统一为裸物品/标签名。 */
export function stripNamespace(name: string): string {
  if (typeof name !== "string") return name;
  const s = name.startsWith("#") ? name.slice(1) : name;
  const idx = s.indexOf(":");
  return idx === -1 ? s : s.slice(idx + 1);
}

function isTagRef(entry: unknown): entry is string {
  return typeof entry === "string" && entry.startsWith("#");
}

// ---------------------------------------------------------------------------
// tag 解析器（Requirement 1.4：递归展开嵌套 tag，环剪除）
// ---------------------------------------------------------------------------

/**
 * 构建 tag 解析器。recipes.json 的 tags 支持标签嵌套标签
 * （如 planks → 各木板；logs_that_burn → #minecraft:oak_logs …）。
 * 返回 resolve(name) → 裸物品名数组（递归展平，带环剪除；与 reconcile 脚本 buildTagResolver 同构）。
 */
export function buildTagResolver(tagsJson: Record<string, string[]> | undefined): (name: string) => string[] {
  const tags = tagsJson ?? {};
  const lookup = (rawName: string): string[] | null => {
    const bare = stripNamespace(rawName);
    return tags[`minecraft:${bare}`] ?? tags[bare] ?? null;
  };
  const cache = new Map<string, string[]>();
  const resolve = (rawName: string, seen: Set<string> = new Set()): string[] => {
    const bare = stripNamespace(rawName);
    const cached = cache.get(bare);
    if (cached) return cached;
    if (seen.has(bare)) return []; // 标签环：剪除
    const members = lookup(bare);
    if (!members) return []; // 未知标签：无法展开（正常不出现）
    seen.add(bare);
    const out = new Set<string>();
    for (const m of members) {
      if (isTagRef(m)) {
        for (const item of resolve(m, seen)) out.add(item);
      } else {
        out.add(stripNamespace(m));
      }
    }
    seen.delete(bare);
    const arr = [...out];
    cache.set(bare, arr);
    return arr;
  };
  return resolve;
}

// ---------------------------------------------------------------------------
// 默认 recipes.json 路径解析（项目根）
// ---------------------------------------------------------------------------

function defaultRecipesPath(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  // __dirname = <root>/OlelaSystem2/src-api/src/core/preparation
  const SRC_API_DIR = path.resolve(__dirname, "..", "..", ".."); // → src-api
  const PROJECT_ROOT = path.resolve(SRC_API_DIR, "..", ".."); // → 项目根
  return path.join(PROJECT_ROOT, "recipes.json");
}

// ---------------------------------------------------------------------------
// RecipeGraph
// ---------------------------------------------------------------------------

export interface RecipeGraphOptions {
  /** 覆盖 recipes.json 路径（默认项目根 recipes.json）。测试可注入。 */
  recipesPath?: string;
  /** 直接注入已解析的 recipes.json 对象（优先于 recipesPath）。测试可注入。 */
  recipesJson?: unknown;
  /** 覆盖 registry（默认 loadMcRegistry()）。测试可注入。 */
  registry?: McRegistry;
}

/**
 * RecipeGraph —— 归一化的可用配方索引。
 *
 * 构造即：① 校验并加载 1.21.4 registry（无法提供则抛 VersionMismatchError → 拒绝启动）；
 * ② 读入 recipes.json；③ 过滤为 shaped/shapeless；④ 展开 tag、归一化并建立
 * recipesByResult[产物名] → UsableRecipe[] 索引。
 */
export class RecipeGraph {
  /** 索引：产物名（归一化） → 可用配方列表。 */
  private readonly recipesByResult: Map<string, UsableRecipe[]> = new Map();

  /** minecraft-data 1.21.4 registry（名称校验用）。 */
  private readonly registry: McRegistry;

  /** 加载统计（供日志/单测断言）。 */
  readonly stats: {
    sourceVersion: string;
    rawResultKeys: number;
    rawRecipeCount: number;
    filteredRecipeCount: number;
    usableRecipeCount: number;
    producibleItemCount: number;
    droppedUnknownResult: number;
    droppedEmptyInputSlot: number;
  };

  constructor(options: RecipeGraphOptions = {}) {
    // Requirement 1.5：校验 1.21.4 registry；无法提供则抛 VersionMismatchError。
    this.registry = options.registry ?? loadMcRegistry();

    const recipesJson = this.resolveRecipesJson(options);
    const resolveTag = buildTagResolver(recipesJson.tags);
    const recipesByResult = recipesJson.recipesByResult ?? {};

    let rawRecipeCount = 0;
    let filteredRecipeCount = 0;
    let usableRecipeCount = 0;
    let droppedUnknownResult = 0;
    let droppedEmptyInputSlot = 0;

    for (const rawList of Object.values(recipesByResult)) {
      if (!Array.isArray(rawList)) continue;
      for (const raw of rawList) {
        rawRecipeCount += 1;

        // Requirement 1.2：仅保留 shaped/shapeless，其余过滤。
        if (!USABLE_RECIPE_TYPES.has(raw.type as UsableRecipeType)) {
          filteredRecipeCount += 1;
          continue;
        }

        const normalized = this.normalizeRecipe(raw, resolveTag);
        if (!normalized) {
          droppedUnknownResult += 1;
          continue;
        }
        if (normalized.droppedEmptyInputSlot) {
          droppedEmptyInputSlot += normalized.droppedEmptyInputSlot;
        }

        const recipe = normalized.recipe;
        const bucket = this.recipesByResult.get(recipe.result.name);
        if (bucket) {
          bucket.push(recipe);
        } else {
          this.recipesByResult.set(recipe.result.name, [recipe]);
        }
        usableRecipeCount += 1;
      }
    }

    this.stats = {
      sourceVersion: recipesJson.meta?.version ?? "unknown",
      rawResultKeys: Object.keys(recipesByResult).length,
      rawRecipeCount,
      filteredRecipeCount,
      usableRecipeCount,
      producibleItemCount: this.recipesByResult.size,
      droppedUnknownResult,
      droppedEmptyInputSlot,
    };
  }

  // -------------------------------------------------------------------------
  // 查询 API（供 CraftPlanner 使用）
  // -------------------------------------------------------------------------

  /** 返回产出该物品的全部可用配方（无则空数组）。归一化名（去 minecraft: 前缀）。 */
  getRecipesFor(itemName: string): UsableRecipe[] {
    return this.recipesByResult.get(stripNamespace(itemName)) ?? [];
  }

  /** 该物品是否为任一可用配方的产物（即：可合成，非叶子）。 */
  isProducible(itemName: string): boolean {
    return this.recipesByResult.has(stripNamespace(itemName));
  }

  /** 全部可产出物品名集合（recipesByResult 的键）。 */
  producibleItems(): string[] {
    return [...this.recipesByResult.keys()];
  }

  /** 该名称是否为 1.21.4 registry 已知物品（Requirement 1.5 归一化/校验辅助）。 */
  isKnownItem(itemName: string): boolean {
    return Boolean(this.registry.itemsByName?.[stripNamespace(itemName)]);
  }

  // -------------------------------------------------------------------------
  // 内部：解析、归一化
  // -------------------------------------------------------------------------

  private resolveRecipesJson(options: RecipeGraphOptions): RawRecipesJson {
    if (options.recipesJson !== undefined) {
      return options.recipesJson as RawRecipesJson;
    }
    const recipesPath = options.recipesPath ?? defaultRecipesPath();
    let raw: string;
    try {
      raw = fs.readFileSync(recipesPath, "utf8");
    } catch (error) {
      const message = (error as Error)?.message ?? String(error);
      throw new Error(`RecipeGraph: 读取 recipes.json 失败 (${recipesPath}): ${message}`);
    }
    try {
      return JSON.parse(raw) as RawRecipesJson;
    } catch (error) {
      const message = (error as Error)?.message ?? String(error);
      throw new Error(`RecipeGraph: 解析 recipes.json 失败 (${recipesPath}): ${message}`);
    }
  }

  /**
   * 归一化一条原始配方为 UsableRecipe（Requirement 1.3/1.4）。
   * - result → {name(归一化), count(默认1)}；result 名未知 registry → 返回 null（丢弃并记数）。
   * - shaped 走 pattern（二维），shapeless 走 ingredients；同候选集的输入位合并计数。
   * - 每个 ingredient slot 用 resolveTag 展开为候选物品名集合（含嵌套 tag），并按 registry 剔除未知名。
   */
  private normalizeRecipe(
    raw: RawRecipe,
    resolveTag: (name: string) => string[],
  ): { recipe: UsableRecipe; droppedEmptyInputSlot: number } | null {
    const resultName = stripNamespace(raw.result?.item ?? raw.result?.name ?? "");
    if (!resultName || !this.isKnownItem(resultName)) {
      return null;
    }
    const result: RecipeResult = {
      name: resultName,
      count: raw.result?.count ?? 1,
    };

    // slotKey(候选集签名) → { names, count }；合并相同候选集的多个输入位。
    const slots = new Map<string, RecipeInput>();
    let droppedEmptyInputSlot = 0;
    const pushSlot = (names: string[]): void => {
      if (names.length === 0) return; // 空格（pattern 的空位）不计
      const key = names.join("|");
      const cur = slots.get(key);
      if (cur) {
        cur.count += 1;
      } else {
        slots.set(key, { names, count: 1 });
      }
    };

    // 候选集要再按「bot 端执行器真的合得出来」收窄一次，见 narrowToExecutableNames。
    const narrow = (names: string[]): string[] => narrowToExecutableNames(resultName, names);

    if (raw.type === "shaped" && Array.isArray(raw.pattern)) {
      for (const row of raw.pattern) {
        if (!Array.isArray(row)) continue;
        for (const cell of row) {
          const names = narrow(this.normalizeSlot(cell, resolveTag));
          if (cell && names.length === 0) droppedEmptyInputSlot += 1;
          pushSlot(names);
        }
      }
    } else if (raw.type === "shapeless" && Array.isArray(raw.ingredients)) {
      for (const ing of raw.ingredients) {
        const names = narrow(this.normalizeSlot(ing, resolveTag));
        if (ing && names.length === 0) droppedEmptyInputSlot += 1;
        pushSlot(names);
      }
    }

    const recipe = completeKnownRecipeInputs({
      id: this.makeRecipeId(raw, resultName),
      type: raw.type as UsableRecipeType,
      result,
      inputs: Array.from(slots.values()),
      // Ported addition: keep the recipe's own 3x3 requirement so callers can decide
      // whether a configured workbench is needed before a bot is attached.
      requiresTable: Boolean(raw.requiresTable),
    });
    return { recipe, droppedEmptyInputSlot };
  }

  /**
   * 把一个 ingredient slot 归一化为候选物品名数组（Requirement 1.4）。
   * slot 形态：null | {item} | {tag,items} | {tag}。
   * tag 引用（# 前缀）递归展开为候选集；按 registry 剔除未知名（真值源仍是 recipes.json）。
   */
  private normalizeSlot(slot: RawSlot, resolveTag: (name: string) => string[]): string[] {
    if (!slot) return [];
    const out = new Set<string>();
    const addEntry = (entry: string): void => {
      if (isTagRef(entry)) {
        for (const item of resolveTag(entry)) out.add(item);
      } else {
        out.add(stripNamespace(entry));
      }
    };
    if (Array.isArray(slot.items) && slot.items.length > 0) {
      for (const it of slot.items) addEntry(it);
    } else if (typeof slot.item === "string") {
      addEntry(slot.item);
    } else if (typeof slot.tag === "string") {
      for (const item of resolveTag(slot.tag)) out.add(item);
    }
    // registry 校验：剔除未知名（正常情况下 1.21.4 无剔除）。
    return [...out].filter((name) => this.isKnownItem(name));
  }

  /**
   * 生成稳定配方 id（供 CraftStep.recipeId 回指与去重）。
   * 优先用数据包文件名（去 .json，天然唯一）；缺失时回退 `<result>#<hash>`。
   */
  private makeRecipeId(raw: RawRecipe, resultName: string): string {
    if (typeof raw.file === "string" && raw.file.length > 0) {
      return raw.file.replace(/\.json$/i, "");
    }
    return `${resultName}#${raw.type}`;
  }
}

// ---------------------------------------------------------------------------
// 单例（服务端启动加载一次；测试用 new RecipeGraph(...) 注入）
// ---------------------------------------------------------------------------

let cachedGraph: RecipeGraph | null = null;

/** 获取进程级 RecipeGraph 单例（首次调用时从项目根 recipes.json 加载）。 */
export function getRecipeGraph(): RecipeGraph {
  if (!cachedGraph) {
    cachedGraph = new RecipeGraph();
  }
  return cachedGraph;
}

/** 仅供测试：清除单例缓存。 */
export function resetRecipeGraphForTest(): void {
  cachedGraph = null;
}
