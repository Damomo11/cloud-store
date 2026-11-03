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
var structureHarvestProfile_exports = {};
__export(structureHarvestProfile_exports, {
  isValidStructureHarvestProfile: () => isValidStructureHarvestProfile
});
module.exports = __toCommonJS(structureHarvestProfile_exports);
const ACTIVE_STRUCTURES = [
  "minecraft:village_plains",
  "minecraft:village_savanna",
  "minecraft:village_desert"
];
const ACTIVE_BEDS = [
  "white_bed",
  "orange_bed",
  "magenta_bed",
  "light_blue_bed",
  "yellow_bed",
  "lime_bed",
  "pink_bed",
  "gray_bed",
  "light_gray_bed",
  "cyan_bed",
  "purple_bed",
  "blue_bed",
  "brown_bed",
  "green_bed",
  "red_bed",
  "black_bed"
];
function exactStringSet(value, expected) {
  if (!Array.isArray(value) || value.length !== expected.length) return false;
  const actual = new Set(value);
  return actual.size === expected.length && expected.every((entry) => actual.has(entry));
}
function isValidStructureHarvestProfile(value, sourceBlock) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const profile = value;
  if (profile.profileId !== "village_hay_pile_v1" || profile.dimension !== "overworld") return false;
  if (sourceBlock !== "hay_block" || !exactStringSet(profile.structures, ACTIVE_STRUCTURES)) return false;
  if (profile.locateRadius !== 1e4 || profile.verificationRadius !== 160 || profile.targetRadius !== 128) return false;
  if (!exactStringSet(profile.targetBlocks, ["hay_block"])) return false;
  const navigation = profile.navigation;
  if (!navigation || navigation.allowPathDigging !== false) return false;
  if (!Array.isArray(profile.markerGroups) || profile.markerGroups.length !== 3) return false;
  const groups = /* @__PURE__ */ new Map();
  for (const raw of profile.markerGroups) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const group = raw;
    if (typeof group.label !== "string" || groups.has(group.label)) return false;
    groups.set(group.label, group);
  }
  const matches = (label, blocks) => {
    const group = groups.get(label);
    return !!group && group.minCount === 1 && exactStringSet(group.blocks, blocks);
  };
  return matches("bell", ["bell"]) && matches("bed", ACTIVE_BEDS) && matches("hay", ["hay_block"]);
}
