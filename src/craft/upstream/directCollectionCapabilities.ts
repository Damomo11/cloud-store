import type {
  CollectMethod,
  DirectCapabilityDependency,
  DirectCollectionStatus,
  DirectPickupValidation,
  ReasonCategory,
} from "./types";

export type DirectCollectionCapability = {
  target: string;
  status: DirectCollectionStatus;
  method: CollectMethod;
  sourceBlock: string;
  dimensions: string[];
  requiredTool?: string;
  requiredEnchantment?: string;
  consumables?: Array<{ name: string; quantityPerTarget: number }>;
  pickupValidation: DirectPickupValidation;
  dependency?: DirectCapabilityDependency;
};

export type DirectTargetRejection = {
  target: string;
  reason: "unsupported_capability" | "experimental_capability_disabled";
  category: ReasonCategory;
  status: DirectCollectionStatus;
};

type Environment = Record<string, string | undefined>;

const EXPERIMENTAL_DIRECT_TARGETS: Readonly<Record<string, DirectCollectionCapability>> = {
  iron_ore: Object.freeze({
    target: "iron_ore",
    status: "experimental",
    method: "mine_underground",
    sourceBlock: "iron_ore",
    dimensions: ["overworld"],
    requiredTool: "diamond_pickaxe",
    requiredEnchantment: "silk_touch",
    pickupValidation: "exact_target_item",
    dependency: "dimension",
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
    dependency: "dimension",
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
    dependency: "dimension",
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
    dependency: "dimension",
  }),
};

// These sources are intentionally represented as capabilities rather than a
// second planner blocklist. The executor cannot safely collect them in this
// campaign, while coal/copper/gold remain ordinary resolver-backed targets.
const UNSUPPORTED_DIRECT_TARGETS: Readonly<Record<string, DirectCollectionCapability>> = {
  diamond_ore: Object.freeze({
    target: "diamond_ore",
    status: "unsupported",
    method: "mine_underground",
    sourceBlock: "diamond_ore",
    dimensions: ["overworld"],
    pickupValidation: "exact_target_item",
    dependency: "dimension",
  }),
  deepslate_diamond_ore: Object.freeze({
    target: "deepslate_diamond_ore",
    status: "unsupported",
    method: "mine_underground",
    sourceBlock: "deepslate_diamond_ore",
    dimensions: ["overworld"],
    pickupValidation: "exact_target_item",
    dependency: "dimension",
  }),
  nether_quartz_ore: Object.freeze({
    target: "nether_quartz_ore",
    status: "unsupported",
    method: "mine_underground",
    sourceBlock: "nether_quartz_ore",
    dimensions: ["the_nether"],
    pickupValidation: "exact_target_item",
    dependency: "dimension",
  }),
  nether_gold_ore: Object.freeze({
    target: "nether_gold_ore",
    status: "unsupported",
    method: "mine_underground",
    sourceBlock: "nether_gold_ore",
    dimensions: ["the_nether"],
    pickupValidation: "exact_target_item",
    dependency: "dimension",
  }),
  ancient_debris: Object.freeze({
    target: "ancient_debris",
    status: "unsupported",
    method: "mine_underground",
    sourceBlock: "ancient_debris",
    dimensions: ["the_nether"],
    pickupValidation: "exact_target_item",
    dependency: "dimension",
  }),
};

const CAPABILITIES: Readonly<Record<string, DirectCollectionCapability>> = Object.freeze({
  ...EXPERIMENTAL_DIRECT_TARGETS,
  ...UNSUPPORTED_DIRECT_TARGETS,
});

function normalizeTarget(name: string): string {
  return String(name ?? "").replace(/^minecraft:/, "").trim().toLowerCase();
}

function experimentalFlag(target: string): string {
  return `PREPARE_EXPERIMENTAL_DIRECT_${target.toUpperCase()}`;
}

function enabled(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

/** Return a defensive copy so callers cannot mutate the immutable registry. */
export function directCollectionCapability(name: string): DirectCollectionCapability | null {
  const capability = CAPABILITIES[normalizeTarget(name)];
  if (!capability) return null;
  return {
    ...capability,
    dimensions: [...capability.dimensions],
    consumables: capability.consumables?.map((item) => ({ ...item })),
  };
}

/**
 * Resolve target-level direct collection rejection. Experimental entries are
 * independently gated so proving one ore cannot authorize another.
 */
export function directTargetRejection(
  name: string,
  env: Environment = process.env,
): DirectTargetRejection | null {
  const target = normalizeTarget(name);
  const capability = CAPABILITIES[target];
  if (!capability) return null;
  if (capability.status === "unsupported") {
    return {
      target,
      reason: "unsupported_capability",
      category: "excluded",
      status: capability.status,
    };
  }
  if (capability.status === "experimental" && !enabled(env[experimentalFlag(target)])) {
    return {
      target,
      reason: "experimental_capability_disabled",
      category: "out_of_collect_range",
      status: capability.status,
    };
  }
  return null;
}

export function isDirectCollectionEnabled(
  capability: DirectCollectionCapability,
  env: Environment = process.env,
): boolean {
  return capability.status !== "unsupported"
    && (capability.status !== "experimental" || enabled(env[experimentalFlag(capability.target)]));
}
