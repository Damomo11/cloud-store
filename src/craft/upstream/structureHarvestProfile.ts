import type { StructureHarvestProfile } from "./types";

const ACTIVE_STRUCTURES = [
  "minecraft:village_plains",
  "minecraft:village_savanna",
  "minecraft:village_desert",
] as const;

const ACTIVE_BEDS = [
  "white_bed", "orange_bed", "magenta_bed", "light_blue_bed",
  "yellow_bed", "lime_bed", "pink_bed", "gray_bed",
  "light_gray_bed", "cyan_bed", "purple_bed", "blue_bed",
  "brown_bed", "green_bed", "red_bed", "black_bed",
] as const;

function exactStringSet(value: unknown, expected: readonly string[]): boolean {
  if (!Array.isArray(value) || value.length !== expected.length) return false;
  const actual = new Set(value);
  return actual.size === expected.length && expected.every((entry) => actual.has(entry));
}

export function isValidStructureHarvestProfile(
  value: unknown,
  sourceBlock: string | null | undefined,
): value is StructureHarvestProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const profile = value as Record<string, unknown>;
  if (profile.profileId !== "village_hay_pile_v1" || profile.dimension !== "overworld") return false;
  if (sourceBlock !== "hay_block" || !exactStringSet(profile.structures, ACTIVE_STRUCTURES)) return false;
  if (profile.locateRadius !== 10000 || profile.verificationRadius !== 160 || profile.targetRadius !== 128) return false;
  if (!exactStringSet(profile.targetBlocks, ["hay_block"])) return false;
  const navigation = profile.navigation as Record<string, unknown> | null;
  if (!navigation || navigation.allowPathDigging !== false) return false;
  if (!Array.isArray(profile.markerGroups) || profile.markerGroups.length !== 3) return false;

  const groups = new Map<string, Record<string, unknown>>();
  for (const raw of profile.markerGroups) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const group = raw as Record<string, unknown>;
    if (typeof group.label !== "string" || groups.has(group.label)) return false;
    groups.set(group.label, group);
  }
  const matches = (label: string, blocks: readonly string[]) => {
    const group = groups.get(label);
    return !!group && group.minCount === 1 && exactStringSet(group.blocks, blocks);
  };
  return matches("bell", ["bell"]) && matches("bed", ACTIVE_BEDS) && matches("hay", ["hay_block"]);
}
