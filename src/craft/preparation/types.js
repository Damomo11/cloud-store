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
var types_exports = {};
__export(types_exports, {
  REASON_CATEGORY_LABELS: () => REASON_CATEGORY_LABELS,
  TERMINAL_TASK_STATES: () => TERMINAL_TASK_STATES
});
module.exports = __toCommonJS(types_exports);
const REASON_CATEGORY_LABELS = {
  excluded: "\u6392\u9664\u9879",
  sealed_tier: "\u5C01\u5B58 tier",
  no_furnace_intermediate: "\u65E0\u7194\u7089\u4E2D\u95F4\u4EA7\u7269",
  out_of_collect_range: "\u8D85\u51FA\u91C7\u96C6\u8303\u56F4",
  mob_or_aquatic_excluded: "\u602A\u7269\u6216\u6C34\u751F\u6392\u9664"
};
const TERMINAL_TASK_STATES = ["done", "failed", "cancelled"];
