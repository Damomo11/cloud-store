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
var ReconciliationCheck_exports = {};
__export(ReconciliationCheck_exports, {
  ALIAS_TABLE_UNAVAILABLE_PREFIX: () => ALIAS_TABLE_UNAVAILABLE_PREFIX,
  DEFAULT_ALIAS_FILE: () => DEFAULT_ALIAS_FILE,
  ReconciliationBlockedError: () => ReconciliationBlockedError,
  assertReconciliationPassed: () => assertReconciliationPassed,
  getBlockingReport: () => getBlockingReport,
  isPreparationBlocked: () => isPreparationBlocked,
  isProductCollectableViaOre: () => isProductCollectableViaOre,
  loadAliasTable: () => loadAliasTable,
  resetAliasCacheForTest: () => resetAliasCacheForTest,
  resolveOreAlias: () => resolveOreAlias
});
module.exports = __toCommonJS(ReconciliationCheck_exports);
var import_node_fs = __toESM(require("node:fs"));
var import_node_path = __toESM(require("node:path"));
var import_node_url = require("node:url");
const DEFAULT_ALIAS_FILE = import_node_path.default.join(
  __dirname,
  "../../../data/resource-source-map.alias.json"
);
const ALIAS_TABLE_UNAVAILABLE_PREFIX = "\u77FF\u7269\u522B\u540D\u8868\u4E0D\u53EF\u7528\uFF08\u8BF7\u5148\u8FD0\u884C W0 \u5BF9\u8D26 npm run reconcile\uFF09";
class ReconciliationBlockedError extends Error {
  undetermined;
  constructor(undetermined) {
    const names = undetermined.map((u) => u.name).join(", ");
    super(`W0 \u5BF9\u8D26\u5B58\u5728\u672A\u5B9A\u593A\u9519\u4F4D\uFF0Cpreparation \u529F\u80FD\u88AB\u963B\u65AD: ${names}`);
    this.name = "ReconciliationBlockedError";
    this.undetermined = undetermined;
  }
}
let cached = null;
let cachedPath = null;
function loadAliasTable(filePath = DEFAULT_ALIAS_FILE) {
  if (cached && cachedPath === filePath) {
    return cached;
  }
  let raw;
  try {
    raw = import_node_fs.default.readFileSync(filePath, "utf-8");
  } catch (error) {
    throw new Error(
      `\u65E0\u6CD5\u8BFB\u53D6\u522B\u540D\u8868 ${filePath}\uFF08\u8BF7\u5148\u8FD0\u884C W0 \u5BF9\u8D26: npm run reconcile\uFF09: ${error?.message ?? String(error)}`
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`\u522B\u540D\u8868 ${filePath} JSON \u89E3\u6790\u5931\u8D25: ${error?.message ?? String(error)}`);
  }
  const table = normalizeAliasTable(parsed);
  cached = table;
  cachedPath = filePath;
  return table;
}
function resolveOreAlias(product, filePath = DEFAULT_ALIAS_FILE) {
  const table = loadAliasTable(filePath);
  return table.aliases[product] ?? null;
}
function isProductCollectableViaOre(product, filePath = DEFAULT_ALIAS_FILE) {
  return resolveOreAlias(product, filePath) !== null;
}
function isPreparationBlocked(filePath = DEFAULT_ALIAS_FILE) {
  try {
    return loadAliasTable(filePath).blocking.blocked;
  } catch {
    return true;
  }
}
function getBlockingReport(filePath = DEFAULT_ALIAS_FILE) {
  try {
    return loadAliasTable(filePath).blocking;
  } catch {
    return { blocked: true, undetermined: [], determinedLeaves: [], determinedMapKeys: [] };
  }
}
function assertReconciliationPassed(filePath = DEFAULT_ALIAS_FILE) {
  const report = getBlockingReport(filePath);
  if (report.blocked) {
    throw new ReconciliationBlockedError(report.undetermined);
  }
}
function resetAliasCacheForTest() {
  cached = null;
  cachedPath = null;
}
function normalizeAliasTable(parsed) {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("\u522B\u540D\u8868\u7ED3\u6784\u975E\u6CD5\uFF1A\u9876\u5C42\u4E0D\u662F\u5BF9\u8C61");
  }
  const obj = parsed;
  const aliases = obj.aliases ?? {};
  const blockingRaw = obj.blocking ?? {};
  if (typeof aliases !== "object") {
    throw new Error("\u522B\u540D\u8868\u7ED3\u6784\u975E\u6CD5\uFF1Aaliases \u4E0D\u662F\u5BF9\u8C61");
  }
  const blocking = {
    blocked: Boolean(blockingRaw.blocked),
    undetermined: Array.isArray(blockingRaw.undetermined) ? blockingRaw.undetermined : [],
    determinedLeaves: Array.isArray(blockingRaw.determinedLeaves) ? blockingRaw.determinedLeaves : [],
    determinedMapKeys: Array.isArray(blockingRaw.determinedMapKeys) ? blockingRaw.determinedMapKeys : []
  };
  return {
    meta: obj.meta ?? void 0,
    aliases,
    blocking
  };
}
