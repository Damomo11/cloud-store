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
var versionGuard_exports = {};
__export(versionGuard_exports, {
  PREPARATION_MC_VERSION: () => PREPARATION_MC_VERSION,
  VersionMismatchError: () => VersionMismatchError,
  isKnownBlock: () => isKnownBlock,
  isKnownItem: () => isKnownItem,
  loadMcRegistry: () => loadMcRegistry,
  resetRegistryCacheForTest: () => resetRegistryCacheForTest
});
module.exports = __toCommonJS(versionGuard_exports);
var import_minecraft_data = __toESM(require("minecraft-data"));
const PREPARATION_MC_VERSION = "1.21.11";
class VersionMismatchError extends Error {
  /** 期望的 Minecraft 版本。 */
  expectedVersion;
  constructor(message, expectedVersion = PREPARATION_MC_VERSION) {
    super(message);
    this.name = "VersionMismatchError";
    this.expectedVersion = expectedVersion;
  }
}
let cachedRegistry = null;
function loadMcRegistry() {
  if (cachedRegistry) {
    return cachedRegistry;
  }
  let registry;
  try {
    registry = (0, import_minecraft_data.default)(PREPARATION_MC_VERSION);
  } catch (error) {
    const message = error?.message ?? String(error);
    throw fail(`\u52A0\u8F7D minecraft-data('${PREPARATION_MC_VERSION}') \u65F6\u629B\u51FA\u5F02\u5E38: ${message}`);
  }
  if (!registry) {
    throw fail(`minecraft-data \u672A\u63D0\u4F9B\u7248\u672C '${PREPARATION_MC_VERSION}' \u7684 registry`);
  }
  const itemCount = countKeys(registry.itemsByName);
  if (itemCount === 0) {
    throw fail(`minecraft-data('${PREPARATION_MC_VERSION}') \u7684 itemsByName registry \u4E3A\u7A7A\u6216\u7F3A\u5931`);
  }
  const blockCount = countKeys(registry.blocksByName);
  if (blockCount === 0) {
    throw fail(`minecraft-data('${PREPARATION_MC_VERSION}') \u7684 blocksByName registry \u4E3A\u7A7A\u6216\u7F3A\u5931`);
  }
  cachedRegistry = registry;
  return registry;
}
function isKnownItem(name) {
  const registry = loadMcRegistry();
  return Boolean(registry.itemsByName?.[name]);
}
function isKnownBlock(name) {
  const registry = loadMcRegistry();
  return Boolean(registry.blocksByName?.[name]);
}
function resetRegistryCacheForTest() {
  cachedRegistry = null;
}
function countKeys(map) {
  if (!map || typeof map !== "object") {
    return 0;
  }
  return Object.keys(map).length;
}
function fail(reason) {
  console.error(`[versionGuard] \u7248\u672C\u4E0D\u5339\u914D: ${reason}`);
  return new VersionMismatchError(reason);
}
