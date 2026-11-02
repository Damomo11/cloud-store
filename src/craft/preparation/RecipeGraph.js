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
var RecipeGraph_exports = {};
__export(RecipeGraph_exports, {
  FILTERED_RECIPE_TYPES: () => FILTERED_RECIPE_TYPES,
  RecipeGraph: () => RecipeGraph,
  USABLE_RECIPE_TYPES: () => USABLE_RECIPE_TYPES,
  buildTagResolver: () => buildTagResolver,
  completeKnownRecipeInputs: () => completeKnownRecipeInputs,
  getRecipeGraph: () => getRecipeGraph,
  narrowToExecutableNames: () => narrowToExecutableNames,
  resetExecutableIngredientCache: () => resetExecutableIngredientCache,
  resetRecipeGraphForTest: () => resetRecipeGraphForTest,
  stripNamespace: () => stripNamespace
});
module.exports = __toCommonJS(RecipeGraph_exports);
var import_node_fs = __toESM(require("node:fs"));
var import_node_path = __toESM(require("node:path"));
var import_node_url = require("node:url");
var import_versionGuard = require("./versionGuard");
const USABLE_RECIPE_TYPES = /* @__PURE__ */ new Set([
  "shaped",
  "shapeless"
]);
let executableIngredientCache = null;
function executableIngredientIndex() {
  if (executableIngredientCache) return executableIngredientCache;
  const index = /* @__PURE__ */ new Map();
  try {
    const registry = (0, import_versionGuard.loadMcRegistry)();
    const recipes = registry.recipes ?? {};
    const items = registry.items ?? {};
    const nameOf = (id) => {
      const item = items[String(id)];
      return item && typeof item.name === "string" ? stripNamespace(item.name) : "";
    };
    for (const [resultId, list] of Object.entries(recipes)) {
      const resultName = nameOf(resultId);
      if (!resultName || !Array.isArray(list)) continue;
      const ingredients = new Set(index.get(resultName) ?? []);
      for (const recipe of list) {
        const raw = [];
        const ing = recipe.ingredients;
        if (Array.isArray(ing)) raw.push(...ing);
        const shape = recipe.inShape;
        if (Array.isArray(shape)) {
          for (const row of shape) if (Array.isArray(row)) raw.push(...row);
        }
        for (const entry of raw) {
          if (entry == null) continue;
          const id = typeof entry === "object" ? entry.id : entry;
          if (id == null || id === -1) continue;
          const name = nameOf(id);
          if (name) ingredients.add(name);
        }
      }
      if (ingredients.size > 0) index.set(resultName, ingredients);
    }
  } catch {
  }
  executableIngredientCache = index;
  return index;
}
function narrowToExecutableNames(resultName, candidateNames) {
  if (candidateNames.length <= 1) return candidateNames;
  const encodable = executableIngredientIndex().get(stripNamespace(resultName));
  if (!encodable || encodable.size === 0) return candidateNames;
  const usable = candidateNames.filter((name) => encodable.has(name));
  return usable.length > 0 ? usable : candidateNames;
}
function resetExecutableIngredientCache() {
  executableIngredientCache = null;
}
function completeKnownRecipeInputs(recipe) {
  const resultName = stripNamespace(recipe.result.name);
  const expectedDye = resultName.replace(/_wool$/, "_dye");
  const isIncompleteDyeWool = /^dye_.+_wool$/.test(recipe.id) && /_wool$/.test(resultName) && recipe.inputs.length === 1 && recipe.inputs[0].count === 1 && recipe.inputs[0].names.length === 1 && recipe.inputs[0].names[0] === expectedDye;
  if (!isIncompleteDyeWool) return recipe;
  const baseWool = resultName === "black_wool" ? "blue_wool" : "black_wool";
  return {
    ...recipe,
    inputs: [...recipe.inputs, { names: [baseWool], count: 1 }]
  };
}
const FILTERED_RECIPE_TYPES = /* @__PURE__ */ new Set([
  "smelting",
  "blasting",
  "campfire_cooking",
  "smoking",
  "stonecutting",
  "smithing_transform",
  "transmute",
  "special",
  "decorated_pot"
]);
function stripNamespace(name) {
  if (typeof name !== "string") return name;
  const s = name.startsWith("#") ? name.slice(1) : name;
  const idx = s.indexOf(":");
  return idx === -1 ? s : s.slice(idx + 1);
}
function isTagRef(entry) {
  return typeof entry === "string" && entry.startsWith("#");
}
function buildTagResolver(tagsJson) {
  const tags = tagsJson ?? {};
  const lookup = (rawName) => {
    const bare = stripNamespace(rawName);
    return tags[`minecraft:${bare}`] ?? tags[bare] ?? null;
  };
  const cache = /* @__PURE__ */ new Map();
  const resolve = (rawName, seen = /* @__PURE__ */ new Set()) => {
    const bare = stripNamespace(rawName);
    const cached = cache.get(bare);
    if (cached) return cached;
    if (seen.has(bare)) return [];
    const members = lookup(bare);
    if (!members) return [];
    seen.add(bare);
    const out = /* @__PURE__ */ new Set();
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
function defaultRecipesPath() {
  // Ported from olela: recipes.json truth source now lives in cloud-store's data/.
  return import_node_path.default.join(__dirname, "..", "..", "..", "data", "recipes.json");
}
class RecipeGraph {
  /** 索引：产物名（归一化） → 可用配方列表。 */
  recipesByResult = /* @__PURE__ */ new Map();
  /** minecraft-data 1.21.4 registry（名称校验用）。 */
  registry;
  /** 加载统计（供日志/单测断言）。 */
  stats;
  constructor(options = {}) {
    this.registry = options.registry ?? (0, import_versionGuard.loadMcRegistry)();
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
        if (!USABLE_RECIPE_TYPES.has(raw.type)) {
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
      droppedEmptyInputSlot
    };
  }
  // -------------------------------------------------------------------------
  // 查询 API（供 CraftPlanner 使用）
  // -------------------------------------------------------------------------
  /** 返回产出该物品的全部可用配方（无则空数组）。归一化名（去 minecraft: 前缀）。 */
  getRecipesFor(itemName) {
    return this.recipesByResult.get(stripNamespace(itemName)) ?? [];
  }
  /** 该物品是否为任一可用配方的产物（即：可合成，非叶子）。 */
  isProducible(itemName) {
    return this.recipesByResult.has(stripNamespace(itemName));
  }
  /** 全部可产出物品名集合（recipesByResult 的键）。 */
  producibleItems() {
    return [...this.recipesByResult.keys()];
  }
  /** 该名称是否为 1.21.4 registry 已知物品（Requirement 1.5 归一化/校验辅助）。 */
  isKnownItem(itemName) {
    return Boolean(this.registry.itemsByName?.[stripNamespace(itemName)]);
  }
  // -------------------------------------------------------------------------
  // 内部：解析、归一化
  // -------------------------------------------------------------------------
  resolveRecipesJson(options) {
    if (options.recipesJson !== void 0) {
      return options.recipesJson;
    }
    const recipesPath = options.recipesPath ?? defaultRecipesPath();
    let raw;
    try {
      raw = import_node_fs.default.readFileSync(recipesPath, "utf8");
    } catch (error) {
      const message = error?.message ?? String(error);
      throw new Error(`RecipeGraph: \u8BFB\u53D6 recipes.json \u5931\u8D25 (${recipesPath}): ${message}`);
    }
    try {
      return JSON.parse(raw);
    } catch (error) {
      const message = error?.message ?? String(error);
      throw new Error(`RecipeGraph: \u89E3\u6790 recipes.json \u5931\u8D25 (${recipesPath}): ${message}`);
    }
  }
  /**
   * 归一化一条原始配方为 UsableRecipe（Requirement 1.3/1.4）。
   * - result → {name(归一化), count(默认1)}；result 名未知 registry → 返回 null（丢弃并记数）。
   * - shaped 走 pattern（二维），shapeless 走 ingredients；同候选集的输入位合并计数。
   * - 每个 ingredient slot 用 resolveTag 展开为候选物品名集合（含嵌套 tag），并按 registry 剔除未知名。
   */
  normalizeRecipe(raw, resolveTag) {
    const resultName = stripNamespace(raw.result?.item ?? raw.result?.name ?? "");
    if (!resultName || !this.isKnownItem(resultName)) {
      return null;
    }
    const result = {
      name: resultName,
      count: raw.result?.count ?? 1
    };
    const slots = /* @__PURE__ */ new Map();
    let droppedEmptyInputSlot = 0;
    const pushSlot = (names) => {
      if (names.length === 0) return;
      const key = names.join("|");
      const cur = slots.get(key);
      if (cur) {
        cur.count += 1;
      } else {
        slots.set(key, { names, count: 1 });
      }
    };
    const narrow = (names) => narrowToExecutableNames(resultName, names);
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
      type: raw.type,
      result,
      inputs: Array.from(slots.values()),
      // Ported addition: keep the recipe's own 3x3 requirement so callers can decide
      // whether a configured workbench is needed before a bot is attached.
      requiresTable: Boolean(raw.requiresTable)
    });
    return { recipe, droppedEmptyInputSlot };
  }
  /**
   * 把一个 ingredient slot 归一化为候选物品名数组（Requirement 1.4）。
   * slot 形态：null | {item} | {tag,items} | {tag}。
   * tag 引用（# 前缀）递归展开为候选集；按 registry 剔除未知名（真值源仍是 recipes.json）。
   */
  normalizeSlot(slot, resolveTag) {
    if (!slot) return [];
    const out = /* @__PURE__ */ new Set();
    const addEntry = (entry) => {
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
    return [...out].filter((name) => this.isKnownItem(name));
  }
  /**
   * 生成稳定配方 id（供 CraftStep.recipeId 回指与去重）。
   * 优先用数据包文件名（去 .json，天然唯一）；缺失时回退 `<result>#<hash>`。
   */
  makeRecipeId(raw, resultName) {
    if (typeof raw.file === "string" && raw.file.length > 0) {
      return raw.file.replace(/\.json$/i, "");
    }
    return `${resultName}#${raw.type}`;
  }
}
let cachedGraph = null;
function getRecipeGraph() {
  if (!cachedGraph) {
    cachedGraph = new RecipeGraph();
  }
  return cachedGraph;
}
function resetRecipeGraphForTest() {
  cachedGraph = null;
}
