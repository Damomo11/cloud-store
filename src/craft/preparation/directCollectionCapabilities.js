var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var directCollectionCapabilities_exports = {};
__export(directCollectionCapabilities_exports, {
  directCollectionCapability: () => directCollectionCapability,
  directTargetRejection: () => directTargetRejection,
  isDirectCollectionEnabled: () => isDirectCollectionEnabled
});
module.exports = __toCommonJS(directCollectionCapabilities_exports);
const EXPERIMENTAL_DIRECT_TARGETS = {
  iron_ore: Object.freeze({
    target: "iron_ore",
    status: "experimental",
    method: "mine_underground",
    sourceBlock: "iron_ore",
    dimensions: ["overworld"],
    requiredTool: "diamond_pickaxe",
    requiredEnchantment: "silk_touch",
    pickupValidation: "exact_target_item",
    dependency: "dimension"
  }),
  redstone_ore: Object.freeze({
    target: "redstone_ore",
    status: "experimental",
    method: "mine_underground",
    sourceBlock: "redstone_ore",
    dimensions: ["overworld"],
    requiredTool: "diamond_pickaxe",
    requiredEnchantment: "silk_touch",
    pickupValidation: "exact_target_item",
    dependency: "dimension"
  }),
  lapis_ore: Object.freeze({
    target: "lapis_ore",
    status: "experimental",
    method: "mine_underground",
    sourceBlock: "lapis_ore",
    dimensions: ["overworld"],
    requiredTool: "diamond_pickaxe",
    requiredEnchantment: "silk_touch",
    pickupValidation: "exact_target_item",
    dependency: "dimension"
  }),
  emerald_ore: Object.freeze({
    target: "emerald_ore",
    status: "experimental",
    method: "mine_underground",
    sourceBlock: "emerald_ore",
    dimensions: ["overworld"],
    requiredTool: "diamond_pickaxe",
    requiredEnchantment: "silk_touch",
    pickupValidation: "exact_target_item",
    dependency: "dimension"
  })
};
const UNSUPPORTED_DIRECT_TARGETS = {
  diamond_ore: Object.freeze({
    target: "diamond_ore",
    status: "unsupported",
    method: "mine_underground",
    sourceBlock: "diamond_ore",
    dimensions: ["overworld"],
    pickupValidation: "exact_target_item",
    dependency: "dimension"
  }),
  deepslate_diamond_ore: Object.freeze({
    target: "deepslate_diamond_ore",
    status: "unsupported",
    method: "mine_underground",
    sourceBlock: "deepslate_diamond_ore",
    dimensions: ["overworld"],
    pickupValidation: "exact_target_item",
    dependency: "dimension"
  }),
  nether_quartz_ore: Object.freeze({
    target: "nether_quartz_ore",
    status: "unsupported",
    method: "mine_underground",
    sourceBlock: "nether_quartz_ore",
    dimensions: ["the_nether"],
    pickupValidation: "exact_target_item",
    dependency: "dimension"
  }),
  nether_gold_ore: Object.freeze({
    target: "nether_gold_ore",
    status: "unsupported",
    method: "mine_underground",
    sourceBlock: "nether_gold_ore",
    dimensions: ["the_nether"],
    pickupValidation: "exact_target_item",
    dependency: "dimension"
  }),
  ancient_debris: Object.freeze({
    target: "ancient_debris",
    status: "unsupported",
    method: "mine_underground",
    sourceBlock: "ancient_debris",
    dimensions: ["the_nether"],
    pickupValidation: "exact_target_item",
    dependency: "dimension"
  })
};
const CAPABILITIES = Object.freeze({
  ...EXPERIMENTAL_DIRECT_TARGETS,
  ...UNSUPPORTED_DIRECT_TARGETS
});
function normalizeTarget(name) {
  return String(name ?? "").replace(/^minecraft:/, "").trim().toLowerCase();
}
function experimentalFlag(target) {
  return `PREPARE_EXPERIMENTAL_DIRECT_${target.toUpperCase()}`;
}
function enabled(value) {
  return value === "1" || value?.toLowerCase() === "true";
}
function directCollectionCapability(name) {
  const capability = CAPABILITIES[normalizeTarget(name)];
  if (!capability) return null;
  return {
    ...capability,
    dimensions: [...capability.dimensions],
    consumables: capability.consumables?.map((item) => ({ ...item }))
  };
}
function directTargetRejection(name, env = process.env) {
  const target = normalizeTarget(name);
  const capability = CAPABILITIES[target];
  if (!capability) return null;
  if (capability.status === "unsupported") {
    return {
      target,
      reason: "unsupported_capability",
      category: "excluded",
      status: capability.status
    };
  }
  if (capability.status === "experimental" && !enabled(env[experimentalFlag(target)])) {
    return {
      target,
      reason: "experimental_capability_disabled",
      category: "out_of_collect_range",
      status: capability.status
    };
  }
  return null;
}
function isDirectCollectionEnabled(capability, env = process.env) {
  return capability.status !== "unsupported" && (capability.status !== "experimental" || enabled(env[experimentalFlag(capability.target)]));
}
