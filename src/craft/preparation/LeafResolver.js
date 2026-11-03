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
var LeafResolver_exports = {};
__export(LeafResolver_exports, {
  MOB_AQUATIC_HARD_EXCLUDED: () => MOB_AQUATIC_HARD_EXCLUDED,
  ORE_HARD_EXCLUDED: () => ORE_HARD_EXCLUDED,
  PROTOCOL_INCOMPATIBLE_ITEMS: () => PROTOCOL_INCOMPATIBLE_ITEMS,
  bonemealFloraFor: () => bonemealFloraFor,
  createFourGateLeafResolver: () => createFourGateLeafResolver,
  isForbiddenCollectSource: () => isForbiddenCollectSource,
  resetLeafResolverCacheForTest: () => resetLeafResolverCacheForTest
});
module.exports = __toCommonJS(LeafResolver_exports);
var import_node_fs = __toESM(require("node:fs"));
var import_node_path = __toESM(require("node:path"));
var import_structureHarvestProfile = require("./structureHarvestProfile");
var import_RecipeGraph = require("./RecipeGraph");
var import_ReconciliationCheck = require("./ReconciliationCheck");
const ORE_HARD_EXCLUDED = /* @__PURE__ */ new Set([
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
  "soul_soil"
]);
const NETHER_BIOMES = /* @__PURE__ */ new Set([
  "nether_wastes",
  "soul_sand_valley",
  "crimson_forest",
  "warped_forest",
  "basalt_deltas"
]);
function isForbiddenCollectSource(itemRaw, sourceBlockRaw, biomes) {
  const item = (0, import_RecipeGraph.stripNamespace)(itemRaw);
  const source = (0, import_RecipeGraph.stripNamespace)(sourceBlockRaw ?? itemRaw);
  if (ORE_HARD_EXCLUDED.has(item) || ORE_HARD_EXCLUDED.has(source)) return true;
  if (item.startsWith("nether_") || source.startsWith("nether_")) return true;
  return (biomes ?? []).some((raw) => NETHER_BIOMES.has((0, import_RecipeGraph.stripNamespace)(raw)));
}
const MOB_AQUATIC_HARD_EXCLUDED = /* @__PURE__ */ new Set([
  "gunpowder",
  "string",
  "spider_eye",
  "ender_pearl",
  "slime_ball",
  "cod",
  "salmon",
  "ink_sac"
]);
const PROTOCOL_INCOMPATIBLE_ITEMS = /* @__PURE__ */ new Set();
const DISPATCHABLE_METHODS = /* @__PURE__ */ new Set([
  "mine_underground",
  // → Collect_Executor
  "harvest_biome",
  // 方块类/花草 → Collect_Executor
  "bonemeal_grass",
  // 骨粉催生地表花草 → Collect_Executor（harvest_biome 的可再生变体）
  "harvest_structure",
  // 现场指纹验证后的结构资源堆 → Collect_Executor
  // 原木去皮 → Collect_Executor。它是**加工**而非采集：去皮原木既不自然生成也没有合成配方，
  // 唯一途径是对既有原木用斧头右键，所以执行器不扫描也不转场，在站内放置→去皮→砍下。
  // 基础原木由 withStripLogConsumable 注入为 inventoryUse，走既有 supply→buffer 搬运腿。
  "strip_log",
  "mob_drop",
  // 陆生动物白名单 → Combat_Executor（怪物/水生已被硬排除拦截）
  "mob_interact"
  // egg / milk_bucket → Interact_Executor
]);
const FURNACE_RECIPE_TYPES = /* @__PURE__ */ new Set([
  "smelting",
  "blasting",
  "smoking",
  "campfire_cooking"
]);
function dataDir() {
  // Ported: olela data/ -> cloud-store data/ (module lives at <repo>/src/craft/preparation).
  return import_node_path.default.resolve(__dirname, "../../../data");
}
function readJson(filePath) {
  try {
    const raw = import_node_fs.default.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
let cachedResourceMap = null;
let cachedComposite = null;
let cachedFurnace = null;
function loadResourceMap() {
  if (cachedResourceMap) return cachedResourceMap;
  const parsed = readJson(import_node_path.default.join(dataDir(), "resource-source-map.json"));
  cachedResourceMap = parsed?.entries ?? {};
  return cachedResourceMap;
}
let cachedBonemealFlora = null;
function loadBonemealFlora() {
  if (cachedBonemealFlora) return cachedBonemealFlora;
  const parsed = readJson(import_node_path.default.join(dataDir(), "bonemeal-flora-map.json"));
  cachedBonemealFlora = parsed ?? {};
  return cachedBonemealFlora;
}
function bonemealFloraFor(item, override) {
  const map = override ?? loadBonemealFlora();
  const entry = map.products?.[(0, import_RecipeGraph.stripNamespace)(item)];
  if (!entry || entry.preferNaturalHarvest === true) return null;
  const biomes = (entry.biomes ?? []).filter((b) => typeof b === "string" && b);
  if (biomes.length === 0) return null;
  return { biomes, requiresShears: entry.requiresShears === true };
}
function loadCompositeSet() {
  if (cachedComposite) return cachedComposite;
  const parsed = readJson(
    import_node_path.default.join(dataDir(), "unsupported-composite-items.json")
  );
  const set = /* @__PURE__ */ new Set();
  for (const it of parsed?.unsupportedItems ?? []) {
    if (it?.item) set.add((0, import_RecipeGraph.stripNamespace)(it.item));
  }
  cachedComposite = set;
  return set;
}
function projectRootRecipesPath() {
  // Ported: recipes.json truth source now lives in cloud-store's data/.
  return import_node_path.default.join(__dirname, "..", "..", "..", "data", "recipes.json");
}
function loadFurnaceIntermediateSet() {
  if (cachedFurnace) return cachedFurnace;
  const parsed = readJson(projectRootRecipesPath());
  const set = /* @__PURE__ */ new Set();
  const byResult = parsed?.recipesByResult ?? {};
  for (const [key, list] of Object.entries(byResult)) {
    if (!Array.isArray(list)) continue;
    for (const rec of list) {
      if (rec?.type && FURNACE_RECIPE_TYPES.has(rec.type)) {
        const name = (0, import_RecipeGraph.stripNamespace)(rec.result?.item ?? rec.result?.name ?? key);
        if (name) set.add(name);
      }
    }
  }
  cachedFurnace = set;
  return set;
}
function resetLeafResolverCacheForTest() {
  cachedResourceMap = null;
  cachedComposite = null;
  cachedFurnace = null;
}
function unreachable(reason, category) {
  return { reachable: false, unreachable: { reason, category } };
}
function reachable(gap) {
  return { reachable: true, gap };
}
function toolFromEntry(entry) {
  if (!entry.tool) return null;
  return {
    hasBlockForm: Boolean(entry.tool.hasBlockForm),
    sourceBlock: entry.tool.sourceBlock ?? null,
    material: entry.tool.material ?? "default",
    harvestTools: entry.tool.harvestTools ?? null
  };
}
function gapFromEntry(item, entry) {
  const tool = toolFromEntry(entry);
  const baseMethod = entry.method ?? "harvest_biome";
  const flora = baseMethod === "harvest_biome" ? bonemealFloraFor(item) : null;
  if (flora) {
    return {
      method: "bonemeal_grass",
      tool,
      sourceBlock: entry.tool?.sourceBlock ?? (0, import_RecipeGraph.stripNamespace)(item),
      biomes: flora.biomes,
      yRange: { min: entry.yRangeMin ?? null, max: entry.yRangeMax ?? null },
      mobName: null
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
    structureProfile: entry.structureProfile ?? null
  };
}
function gapFromAliasSource(src) {
  return {
    method: src.method ?? "mine_underground",
    tool: src.tool ?? null,
    sourceBlock: src.sourceBlock ?? src.tool?.sourceBlock ?? null,
    biomes: src.biomes ?? null,
    yRange: src.yRange ?? { min: null, max: null },
    // 别名来源均为矿石方块（mine_underground），无掉落生物。
    mobName: null
  };
}
function createFourGateLeafResolver(options = {}) {
  const resourceMap = options.resourceMap ?? null;
  const compositeSet = options.compositeItems ? /* @__PURE__ */ new Set([...options.compositeItems]) : null;
  const resolveAlias = options.resolveAlias ?? ((product) => (0, import_ReconciliationCheck.resolveOreAlias)(product));
  const furnaceSet = options.furnaceIntermediates ? /* @__PURE__ */ new Set([...options.furnaceIntermediates]) : null;
  const getMap = () => resourceMap ?? loadResourceMap();
  const getComposite = () => compositeSet ?? loadCompositeSet();
  const getFurnace = () => furnaceSet ?? loadFurnaceIntermediateSet();
  const resolveInternal = (itemRaw, visited) => {
    const item = (0, import_RecipeGraph.stripNamespace)(itemRaw);
    if (item === "white_wool") {
      return reachable({
        method: "mob_drop",
        tool: null,
        sourceBlock: null,
        biomes: null,
        yRange: { min: null, max: null },
        mobName: "sheep"
      });
    }
    if (item === "leather") {
      return reachable({
        method: "mob_drop",
        tool: null,
        sourceBlock: null,
        biomes: null,
        yRange: { min: null, max: null },
        mobName: "cow"
      });
    }
    if (PROTOCOL_INCOMPATIBLE_ITEMS.has(item)) {
      return unreachable(
        `protocol_version_incompatible: bot=1.21.4 server=1.21.11 item=${item}`,
        "excluded"
      );
    }
    if (visited.has(item)) {
      return unreachable(`\u91CD\u5B9A\u5411\u51FA\u73B0\u73AF\uFF08${item}\uFF09\uFF0C\u65E0\u91C7\u96C6\u8DEF\u5F84`, "out_of_collect_range");
    }
    if (getComposite().has(item)) {
      return unreachable(
        `\u547D\u4E2D unsupported-composite-items \u6E05\u5355\uFF08\u975E\u53F6\u5B50\u590D\u5408\u7269\uFF0C\u786C\u7F16\u7801\u4F9D\u8D56\u53BB\u76AE\u539F\u6728/\u83CC\u67C4\uFF0C\u65E0 tag \u7B49\u4EF7\u8DEF\u5F84\uFF09`,
        "out_of_collect_range"
      );
    }
    const entry = getMap()[item];
    if (isForbiddenCollectSource(item, entry?.tool?.sourceBlock, entry?.biomes)) {
      return unreachable(`\u786C\u6392\u9664\uFF1A\u94BB\u77F3\u77FF\u6216\u4E0B\u754C\u6765\u6E90\uFF08${item}\uFF09\u4E0D\u91C7\u96C6`, "excluded");
    }
    if (MOB_AQUATIC_HARD_EXCLUDED.has(item)) {
      return unreachable(`\u786C\u6392\u9664\uFF1A\u602A\u7269\u6389\u843D/\u6C34\u751F\u751F\u7269\u4EA7\u7269\uFF08${item}\uFF09\u4E00\u671F\u4E0D\u83B7\u53D6`, "mob_or_aquatic_excluded");
    }
    if (entry) {
      const pool = entry.poolStatus;
      if (pool === "excluded") {
        return unreachable(`poolStatus=excluded\uFF08T3 \u6392\u9664\u9879\uFF09`, "excluded");
      }
      if (pool === "sealed") {
        return unreachable(`poolStatus=sealed\uFF08T1/T2 \u5C01\u5B58 tier\uFF0C\u4E00\u671F\u4E0D\u505A\uFF09`, "sealed_tier");
      }
      if (pool !== "active") {
        return unreachable(`poolStatus=${pool ?? "missing"}\uFF0C\u4EC5\u663E\u5F0F active \u6761\u76EE\u53EF\u6D3E\u53D1`, "out_of_collect_range");
      }
      if (entry.supported === false) {
        if (entry.substituteWith) {
          const next = new Set(visited);
          next.add(item);
          return resolveInternal(entry.substituteWith, next);
        }
        return unreachable(`\u6807\u8BB0\u4E3A\u4E0D\u652F\u6301\u91C7\u96C6\u4E14\u65E0 substituteWith \u91CD\u5B9A\u5411\u8DEF\u5F84`, "out_of_collect_range");
      }
      const method = entry.method ?? null;
      if (method === "farm_crop") {
        return unreachable(`method=farm_crop\uFF08\u79CD\u7530\u4E00\u671F\u4E0D\u505A\uFF09`, "out_of_collect_range");
      }
      if (method === "harvest_structure" && !(0, import_structureHarvestProfile.isValidStructureHarvestProfile)(
        entry.structureProfile,
        entry.tool?.sourceBlock ?? item
      )) {
        return unreachable(`method=harvest_structure \u7684 structureProfile \u65E0\u6548\uFF0C\u62D2\u7EDD\u6D3E\u53D1`, "out_of_collect_range");
      }
      if (method && DISPATCHABLE_METHODS.has(method)) {
        return reachable(gapFromEntry(item, entry));
      }
      return unreachable(
        `method=${method ?? "null"} \u65E0\u5BF9\u5E94\u91C7\u96C6\u6267\u884C\u5668`,
        "out_of_collect_range"
      );
    }
    let alias;
    try {
      alias = resolveAlias(item);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return unreachable(`${import_ReconciliationCheck.ALIAS_TABLE_UNAVAILABLE_PREFIX}: ${message}`, "out_of_collect_range");
    }
    if (alias && alias.sources.length > 0) {
      const usable = alias.sources.filter(
        (s) => !isForbiddenCollectSource(
          item,
          s.sourceBlock ?? s.sourceMapKey ?? s.tool?.sourceBlock,
          s.biomes
        )
      );
      if (usable.length === 0) {
        return unreachable(`\u786C\u6392\u9664\uFF1A\u552F\u4E00\u77FF\u77F3\u6765\u6E90\u88AB\u6392\u9664\uFF08${item}\uFF09`, "excluded");
      }
      const active = usable.filter((s) => s.poolStatus === "active");
      const pick = active[0] ?? null;
      if (!pick) {
        const anySealed = usable.some((s) => s.poolStatus === "sealed");
        return unreachable(
          `\u77FF\u77F3\u6765\u6E90 poolStatus \u975E active\uFF08${item}\uFF09`,
          anySealed ? "sealed_tier" : "excluded"
        );
      }
      return reachable(gapFromAliasSource(pick));
    }
    if (getFurnace().has(item)) {
      return unreachable(
        `\u65E0\u7194\u7089\u4E2D\u95F4\u4EA7\u7269\uFF1A${item} \u4EC5\u53EF\u7531\u51B6\u70BC\uFF08smelting/blasting\uFF09\u4EA7\u51FA\uFF0C\u4E00\u671F\u65E0\u7194\u7089\u4E14\u5E93\u5B58\u65E0\u6CD5\u53CD\u62C6\u5F97\u5230`,
        "no_furnace_intermediate"
      );
    }
    return unreachable(`\u65E0\u53EF\u7528\u914D\u65B9\u4E14\u65E0\u91C7\u96C6\u6765\u6E90\uFF08\u4E0D\u5728 ResourceSourceMap\uFF0C\u65E0\u4EA7\u7269\u2194\u77FF\u77F3\u522B\u540D\uFF09`, "out_of_collect_range");
  };
  return {
    resolve(itemRaw) {
      return resolveInternal(itemRaw, /* @__PURE__ */ new Set());
    }
  };
}
