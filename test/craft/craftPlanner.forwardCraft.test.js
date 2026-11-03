var import_vitest = require("./vitest-shim");
var import_RecipeGraph = require("../../src/craft/preparation/RecipeGraph");
var import_CraftPlanner = require("../../src/craft/preparation/CraftPlanner");
var import_types = require("../../src/craft/preparation/types");
// Preserve these upstream regressions against the historical recipe snapshot.
const graph = new import_RecipeGraph.RecipeGraph({ recipesPath: require.resolve("../../data/recipes.json") });
const planner = new import_CraftPlanner.CraftPlanner(graph);
(0, import_vitest.describe)("CraftPlanner white_wool \u771F\u670D\u56DE\u5F52", () => {
  (0, import_vitest.it)("\u73B0\u6709 3 \u7F8A\u6BDB + 5 \u67D3\u6599\u65F6\u628A\u7F3A\u53E3\u89C4\u5212\u4E3A\u730E\u53D6\u767D\u7F8A\u6BDB\uFF0C\u4E0D\u751F\u6210\u65E0\u57FA\u6750\u67D3\u8272\u6B65\u9AA4", () => {
    const plan = planner.plan("white_wool", 8, { available: { white_wool: 3, white_dye: 5 } });
    (0, import_vitest.expect)(plan.ok).toBe(true);
    (0, import_vitest.expect)(plan.inventoryUses).toContainEqual({ name: "white_wool", quantity: 3 });
    (0, import_vitest.expect)(plan.collectGaps).toContainEqual(import_vitest.expect.objectContaining({
      name: "white_wool",
      qty: 5,
      method: "mob_drop",
      mobName: "sheep"
    }));
    (0, import_vitest.expect)(plan.craftSteps).toEqual([]);
    (0, import_vitest.expect)(plan.unreachable).toEqual([]);
  });
  (0, import_vitest.it)("leather \u4F18\u5148\u76F4\u63A5\u730E\u725B\uFF0C\u4E0D\u8D70\u56DB\u5F20 rabbit_hide \u5408\u6210\u4E00\u5F20\u7684\u7A00\u6709\u6389\u843D\u94FE", () => {
    const plan = planner.plan("leather", 8);
    (0, import_vitest.expect)(plan.ok).toBe(true);
    (0, import_vitest.expect)(plan.collectGaps).toEqual([
      import_vitest.expect.objectContaining({
        name: "leather",
        qty: 8,
        method: "mob_drop",
        mobName: "cow"
      })
    ]);
    (0, import_vitest.expect)(plan.craftSteps).toEqual([]);
    (0, import_vitest.expect)(plan.unreachable).toEqual([]);
  });
});
(0, import_vitest.describe)("CraftPlanner \u7ED3\u6784\u91C7\u96C6 profile \u4F20\u64AD", () => {
  (0, import_vitest.it)("\u628A LeafResolver \u7684\u7CBE\u786E\u7ED3\u6784 profile \u4FDD\u7559\u5728 collect gap", () => {
    const profile = {
      profileId: "village_hay_pile_v1",
      dimension: "overworld",
      structures: ["minecraft:village_plains"],
      markerGroups: [{ label: "hay", blocks: ["hay_block"], minCount: 1 }],
      locateRadius: 1e4,
      verificationRadius: 160,
      targetRadius: 128,
      targetBlocks: ["hay_block"],
      navigation: { allowPathDigging: false }
    };
    const structurePlanner = new import_CraftPlanner.CraftPlanner(graph, {
      leafResolver: {
        resolve: () => ({
          reachable: true,
          gap: {
            method: "harvest_structure",
            tool: { hasBlockForm: true, sourceBlock: "hay_block", material: "default", harvestTools: null },
            sourceBlock: "hay_block",
            biomes: null,
            yRange: { min: null, max: null },
            mobName: null,
            structureProfile: profile
          }
        })
      }
    });
    const plan = structurePlanner.plan("hay_block", 8);
    (0, import_vitest.expect)(plan.collectGaps).toEqual([
      import_vitest.expect.objectContaining({
        name: "hay_block",
        qty: 8,
        method: "harvest_structure",
        structureProfile: profile
      })
    ]);
  });
});
function stepIndexOf(plan, resultName) {
  return plan.craftSteps.findIndex((s) => s.result.name === resultName);
}
function stepOf(plan, resultName) {
  return plan.craftSteps.find((s) => s.result.name === resultName);
}
function hasGap(plan, name) {
  return plan.collectGaps.some((g) => g.name === name);
}
function findGap(plan, pred) {
  return plan.collectGaps.find((g) => pred(g.name));
}
function assertTopologicalOrder(plan) {
  const indexByResult = /* @__PURE__ */ new Map();
  plan.craftSteps.forEach((s, i) => indexByResult.set(s.result.name, i));
  plan.craftSteps.forEach((step, i) => {
    for (const input of step.inputs) {
      for (const cand of input.names) {
        const producedAt = indexByResult.get(cand);
        if (producedAt !== void 0) {
          (0, import_vitest.expect)(producedAt).toBeLessThan(i);
        }
      }
    }
  });
}
(0, import_vitest.describe)("CraftPlanner \u6B63\u5411\u5408\u6210 \xB7 chest\uFF08\u7A7A\u5E93\u5B58\uFF0CReq 3.6/3.7\uFF09", () => {
  const plan = planner.plan("chest", 1);
  (0, import_vitest.it)("\u53EF\u5B8C\u6574\u5B8C\u6210\uFF1Aok=true \u4E14 unreachable \u4E3A\u7A7A", () => {
    (0, import_vitest.expect)(plan.ok).toBe(true);
    (0, import_vitest.expect)(plan.unreachable).toEqual([]);
  });
  (0, import_vitest.it)("\u6700\u7EC8\u6B65\u9AA4\u4EA7\u51FA chest\uFF0C\u4E14\u89E6\u53D1\u4E00\u6B21", () => {
    const last = plan.craftSteps[plan.craftSteps.length - 1];
    (0, import_vitest.expect)(last.result.name).toBe("chest");
    (0, import_vitest.expect)(stepOf(plan, "chest").times).toBe(1);
  });
  (0, import_vitest.it)("chest \u9700\u8981 8 \u4E2A\u6728\u677F\u8F93\u5165\uFF083x3 \u53BB\u4E2D\u5FC3\uFF09", () => {
    const chest = stepOf(plan, "chest");
    const planksSlot = chest.inputs.find((inp) => inp.count === 8);
    (0, import_vitest.expect)(planksSlot).toBeTruthy();
    (0, import_vitest.expect)(planksSlot.names).toContain("oak_planks");
  });
  (0, import_vitest.it)("\u62D3\u6251\u5E8F\uFF1A\u6728\u677F\u6B65\u9AA4\u6392\u5728 chest \u4E4B\u524D\uFF0C\u539F\u6728\u91C7\u96C6\u7F3A\u53E3\u5B58\u5728", () => {
    const chestIdx = stepIndexOf(plan, "chest");
    const planksIdx = plan.craftSteps.findIndex((s) => /_planks$/.test(s.result.name));
    (0, import_vitest.expect)(planksIdx).toBeGreaterThanOrEqual(0);
    (0, import_vitest.expect)(planksIdx).toBeLessThan(chestIdx);
    assertTopologicalOrder(plan);
    const log = findGap(plan, (n) => /_log$/.test(n));
    (0, import_vitest.expect)(log).toBeTruthy();
    (0, import_vitest.expect)(log.method).toBe("harvest_biome");
    (0, import_vitest.expect)(plan.estimatedSlots).toBeGreaterThan(0);
  });
});
(0, import_vitest.describe)("CraftPlanner \u6B63\u5411\u5408\u6210 \xB7 iron_pickaxe\uFF08\u5E93\u5B58\u5907\u94C1\u952D\uFF0CReq 3.6\uFF09", () => {
  const plan = planner.plan("iron_pickaxe", 1, { available: { iron_ingot: 3 } });
  (0, import_vitest.it)("\u5907\u94C1\u952D\u540E\u53EF\u5B8C\u6574\u5B8C\u6210\uFF1Aok=true \u4E14 unreachable \u4E3A\u7A7A", () => {
    (0, import_vitest.expect)(plan.ok).toBe(true);
    (0, import_vitest.expect)(plan.unreachable).toEqual([]);
  });
  (0, import_vitest.it)("\u6700\u7EC8\u6B65\u9AA4\u4EA7\u51FA iron_pickaxe\uFF08\u89E6\u53D1\u4E00\u6B21\uFF09\uFF0Cstick \u6B65\u9AA4\u6392\u5728\u5176\u524D", () => {
    const last = plan.craftSteps[plan.craftSteps.length - 1];
    (0, import_vitest.expect)(last.result.name).toBe("iron_pickaxe");
    (0, import_vitest.expect)(stepOf(plan, "iron_pickaxe").times).toBe(1);
    const pickIdx = stepIndexOf(plan, "iron_pickaxe");
    const stickIdx = stepIndexOf(plan, "stick");
    (0, import_vitest.expect)(stickIdx).toBeGreaterThanOrEqual(0);
    (0, import_vitest.expect)(stickIdx).toBeLessThan(pickIdx);
    assertTopologicalOrder(plan);
  });
  (0, import_vitest.it)("iron_ingot \u7531\u5E93\u5B58\u6D88\u8D39\u800C\u975E\u91C7\u96C6\uFF1A\u4E0D\u51FA\u73B0\u5728 collectGaps", () => {
    (0, import_vitest.expect)(hasGap(plan, "iron_ingot")).toBe(false);
    (0, import_vitest.expect)(findGap(plan, (n) => /_log$/.test(n))).toBeTruthy();
  });
});
(0, import_vitest.describe)("CraftPlanner \u6B63\u5411\u5408\u6210 \xB7 piston\uFF08\u5E93\u5B58\u5907\u94C1\u952D\uFF0CReq 3.6/3.7\uFF09", () => {
  const plan = planner.plan("piston", 1, { available: { iron_ingot: 1 } });
  (0, import_vitest.it)("\u5907\u94C1\u952D\u540E\u53EF\u5B8C\u6574\u5B8C\u6210\uFF1Aok=true \u4E14 unreachable \u4E3A\u7A7A", () => {
    (0, import_vitest.expect)(plan.ok).toBe(true);
    (0, import_vitest.expect)(plan.unreachable).toEqual([]);
  });
  (0, import_vitest.it)("\u6700\u7EC8\u6B65\u9AA4\u4EA7\u51FA piston\uFF08\u89E6\u53D1\u4E00\u6B21\uFF09\uFF0C\u6728\u677F\u6B65\u9AA4\u6392\u5728\u5176\u524D", () => {
    const last = plan.craftSteps[plan.craftSteps.length - 1];
    (0, import_vitest.expect)(last.result.name).toBe("piston");
    (0, import_vitest.expect)(stepOf(plan, "piston").times).toBe(1);
    const pistonIdx = stepIndexOf(plan, "piston");
    const planksIdx = plan.craftSteps.findIndex((s) => /_planks$/.test(s.result.name));
    (0, import_vitest.expect)(planksIdx).toBeGreaterThanOrEqual(0);
    (0, import_vitest.expect)(planksIdx).toBeLessThan(pistonIdx);
    assertTopologicalOrder(plan);
  });
  (0, import_vitest.it)("\u91C7\u96C6\u7F3A\u53E3\u542B cobblestone \u4E0E\u5355\u4E2A redstone\uFF0Ciron_ingot \u8D70\u5E93\u5B58\u4E0D\u91C7\u96C6", () => {
    const cobble = plan.collectGaps.find((g) => g.name === "cobblestone");
    const redstone = plan.collectGaps.find((g) => g.name === "redstone");
    (0, import_vitest.expect)(cobble).toBeTruthy();
    (0, import_vitest.expect)(cobble.method).toBe("mine_underground");
    (0, import_vitest.expect)(redstone?.qty).toBe(1);
    (0, import_vitest.expect)(stepOf(plan, "redstone_block")).toBeUndefined();
    (0, import_vitest.expect)(stepOf(plan, "redstone")).toBeUndefined();
    (0, import_vitest.expect)(hasGap(plan, "iron_ingot")).toBe(false);
  });
});
(0, import_vitest.describe)("CraftPlanner \u53EF\u9006\u538B\u7F29\u914D\u65B9 \xB7 \u76F4\u63A5\u91C7\u96C6\u4F18\u5148", () => {
  (0, import_vitest.it)("redstone\xD78 \u76F4\u63A5\u6316 8 \u4E2A\uFF0C\u4E0D\u6267\u884C 9 \u4E2A\u538B\u5757\u518D\u62C6\u5206", () => {
    const plan = planner.plan("redstone", 8);
    (0, import_vitest.expect)(plan.ok).toBe(true);
    (0, import_vitest.expect)(plan.collectGaps).toEqual([
      import_vitest.expect.objectContaining({ name: "redstone", qty: 8, method: "mine_underground" })
    ]);
    (0, import_vitest.expect)(plan.craftSteps).toEqual([]);
  });
  import_vitest.it.each([
    ["stone", "mine_underground"],
    ["deepslate", "mine_underground"],
    ["andesite", "mine_underground"],
    ["diorite", "mine_underground"],
    ["granite", "mine_underground"],
    ["coarse_dirt", "harvest_biome"],
    ["mossy_cobblestone", "harvest_biome"],
    ["terracotta", "harvest_biome"],
    ["white_terracotta", "harvest_biome"],
    ["orange_terracotta", "harvest_biome"],
    ["yellow_terracotta", "harvest_biome"],
    ["brown_terracotta", "harvest_biome"],
    ["red_terracotta", "harvest_biome"],
    ["light_gray_terracotta", "harvest_biome"],
    ["packed_ice", "harvest_biome"],
    ["sandstone", "harvest_biome"],
    ["red_sandstone", "harvest_biome"]
  ])("%s \u4F18\u5148\u76F4\u63A5\u91C7\u96C6\uFF0C\u4E0D\u9012\u5F52\u6D88\u8017\u5176\u5408\u6210\u539F\u6599", (item, method) => {
    const plan = planner.plan(item, 8);
    (0, import_vitest.expect)(plan.ok).toBe(true);
    (0, import_vitest.expect)(plan.collectGaps).toEqual([
      import_vitest.expect.objectContaining({ name: item, qty: 8, method })
    ]);
    (0, import_vitest.expect)(plan.craftSteps).toEqual([]);
    (0, import_vitest.expect)(plan.unreachable).toEqual([]);
  });
  (0, import_vitest.it)("sandstone \u6709\u53D7\u9650\u6D45\u5C42\u6316\u6C99\u80FD\u529B\u540E\u4E0D\u518D\u9012\u5F52\u6D88\u8017 sand", () => {
    const plan = planner.plan("sandstone", 8);
    (0, import_vitest.expect)(plan.ok).toBe(true);
    (0, import_vitest.expect)(plan.collectGaps).toEqual([
      import_vitest.expect.objectContaining({ name: "sandstone", qty: 8, method: "harvest_biome" })
    ]);
    (0, import_vitest.expect)(plan.craftSteps).toEqual([]);
    (0, import_vitest.expect)(plan.unreachable).toEqual([]);
  });
});
(0, import_vitest.describe)("CraftPlanner direct collection capability gates", () => {
  const experimentalTargets = ["iron_ore", "redstone_ore", "lapis_ore", "emerald_ore"];
  (0, import_vitest.it)("rejects every experimental ore when no per-target gate is enabled", () => {
    const previous = /* @__PURE__ */ new Map();
    for (const target of experimentalTargets) {
      const key = `PREPARE_EXPERIMENTAL_DIRECT_${target.toUpperCase()}`;
      previous.set(key, process.env[key]);
      delete process.env[key];
    }
    try {
      for (const target of experimentalTargets) {
        const plan = planner.plan(target, 16);
        (0, import_vitest.expect)(plan.ok).toBe(false);
        (0, import_vitest.expect)(plan.collectGaps).toEqual([]);
        (0, import_vitest.expect)(plan.unreachable).toContainEqual(import_vitest.expect.objectContaining({
          name: target,
          reason: "experimental_capability_disabled"
        }));
      }
    } finally {
      for (const [key, value] of previous) {
        if (value === void 0) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
  import_vitest.it.each(experimentalTargets)("enables only %s and preserves exact pickup metadata", (enabledTarget) => {
    const previous = /* @__PURE__ */ new Map();
    for (const target of experimentalTargets) {
      const key = `PREPARE_EXPERIMENTAL_DIRECT_${target.toUpperCase()}`;
      previous.set(key, process.env[key]);
      delete process.env[key];
    }
    const enabledKey = `PREPARE_EXPERIMENTAL_DIRECT_${enabledTarget.toUpperCase()}`;
    process.env[enabledKey] = "1";
    try {
      const plan = planner.plan(enabledTarget, 16);
      (0, import_vitest.expect)(plan.ok).toBe(true);
      (0, import_vitest.expect)(plan.collectGaps).toContainEqual(import_vitest.expect.objectContaining({
        name: enabledTarget,
        qty: 16,
        method: "mine_underground",
        sourceBlock: enabledTarget,
        requiredTool: "diamond_pickaxe",
        requiredEnchantment: "silk_touch",
        pickupValidation: "exact_target_item",
        capabilityStatus: "experimental"
      }));
      for (const target of experimentalTargets) {
        if (target === enabledTarget) continue;
        (0, import_vitest.expect)(planner.plan(target, 16).unreachable).toContainEqual(import_vitest.expect.objectContaining({
          name: target,
          reason: "experimental_capability_disabled"
        }));
      }
    } finally {
      for (const [key, value] of previous) {
        if (value === void 0) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
(0, import_vitest.describe)("CraftPlanner \u6B63\u5411\u5408\u6210 \xB7 bamboo_mosaic \u591A\u5019\u9009\u62E9\u4F18", () => {
  (0, import_vitest.it)("\u5E93\u5B58 bamboo \u8D70\u5B8C\u6574\u56DB\u6B65\u94FE\uFF0C\u4E0D\u4EA7\u751F stripped_bamboo_block \u91C7\u96C6\u7F3A\u53E3", () => {
    const plan = planner.plan("bamboo_mosaic", 1, { available: { bamboo: 18 } });
    (0, import_vitest.expect)(plan.ok).toBe(true);
    (0, import_vitest.expect)(plan.unreachable).toEqual([]);
    (0, import_vitest.expect)(plan.collectGaps).toEqual([]);
    (0, import_vitest.expect)(plan.inventoryUses).toEqual([{ name: "bamboo", quantity: 18 }]);
    (0, import_vitest.expect)(plan.craftSteps.map((step) => step.result.name)).toEqual([
      "bamboo_block",
      "bamboo_planks",
      "bamboo_slab",
      "bamboo_mosaic"
    ]);
    (0, import_vitest.expect)(stepOf(plan, "bamboo_block").times).toBe(2);
    (0, import_vitest.expect)(stepOf(plan, "bamboo_planks").times).toBe(2);
    (0, import_vitest.expect)(hasGap(plan, "stripped_bamboo_block")).toBe(false);
    assertTopologicalOrder(plan);
  });
  (0, import_vitest.it)("\u771F\u5B9E\u5DF2\u6709 bamboo_block \u65F6\u4ECD\u4FDD\u6301\u5E93\u5B58\u4F18\u5148", () => {
    const plan = planner.plan("bamboo_planks", 2, { available: { bamboo_block: 1 } });
    (0, import_vitest.expect)(plan.ok).toBe(true);
    (0, import_vitest.expect)(plan.inventoryUses).toEqual([{ name: "bamboo_block", quantity: 1 }]);
    (0, import_vitest.expect)(plan.collectGaps).toEqual([]);
    (0, import_vitest.expect)(plan.craftSteps.map((step) => step.result.name)).toEqual(["bamboo_planks"]);
  });
  (0, import_vitest.it)("\u6267\u884C\u5668\u5408\u4E0D\u51FA\u6765\u7684\u53D8\u4F53\u4E0D\u5F97\u8FDB\u5165\u5019\u9009\u96C6\uFF08stripped_bamboo_block \u4E0D\u518D\u88AB\u5F53\u4F5C\u53EF\u7528\u539F\u6599\uFF09", () => {
    const plan = planner.plan("bamboo_planks", 2, { available: { stripped_bamboo_block: 1 } });
    (0, import_vitest.expect)(plan.inventoryUses).toEqual([]);
    const slot = graph.getRecipesFor("bamboo_planks")[0].inputs[0];
    (0, import_vitest.expect)(slot.names).toContain("bamboo_block");
    (0, import_vitest.expect)(slot.names).not.toContain("stripped_bamboo_block");
  });
});
(0, import_vitest.describe)("CraftPlanner \u65E0\u7194\u7089\u4E2D\u95F4\u4EA7\u7269\u4E0D\u53EF\u8FBE\uFF08Req 3.7 / 5.5\uFF09", () => {
  (0, import_vitest.it)("glass \u4EC5\u53EF\u51B6\u70BC\u83B7\u5F97 \u2192 unreachable \u4E14\u539F\u56E0\u7C7B\u522B\u4E3A no_furnace_intermediate", () => {
    const plan = planner.plan("glass", 1);
    (0, import_vitest.expect)(plan.ok).toBe(false);
    const u = plan.unreachable.find((x) => x.name === "glass");
    (0, import_vitest.expect)(u).toBeTruthy();
    (0, import_vitest.expect)(u.category).toBe("no_furnace_intermediate");
    (0, import_vitest.expect)(import_types.REASON_CATEGORY_LABELS[u.category]).toBe("\u65E0\u7194\u7089\u4E2D\u95F4\u4EA7\u7269");
  });
  (0, import_vitest.it)("charcoal \u4EC5\u53EF\u51B6\u70BC\u83B7\u5F97 \u2192 unreachable(no_furnace_intermediate)", () => {
    const plan = planner.plan("charcoal", 1);
    (0, import_vitest.expect)(plan.ok).toBe(false);
    const u = plan.unreachable.find((x) => x.name === "charcoal");
    (0, import_vitest.expect)(u).toBeTruthy();
    (0, import_vitest.expect)(u.category).toBe("no_furnace_intermediate");
  });
  (0, import_vitest.it)("iron_ingot \u65E0\u5E93\u5B58 \u2192 \u53CD\u62C6\u5206\u652F\u73AF\u526A\u9664\u540E\u843D\u4E3A\u53F6\u5B50\uFF0Cunreachable(no_furnace_intermediate)", () => {
    const plan = planner.plan("iron_ingot", 1);
    (0, import_vitest.expect)(plan.ok).toBe(false);
    const u = plan.unreachable.find((x) => x.name === "iron_ingot");
    (0, import_vitest.expect)(u).toBeTruthy();
    (0, import_vitest.expect)(u.category).toBe("no_furnace_intermediate");
  });
  (0, import_vitest.it)("piston \u7A7A\u5E93\u5B58\u65F6 iron_ingot \u5982\u5B9E\u5217\u5165 unreachable \u4E14\u9644\u300C\u65E0\u7194\u7089\u4E2D\u95F4\u4EA7\u7269\u300D\u539F\u56E0", () => {
    const plan = planner.plan("piston", 1);
    (0, import_vitest.expect)(plan.ok).toBe(false);
    const u = plan.unreachable.find((x) => x.name === "iron_ingot");
    (0, import_vitest.expect)(u).toBeTruthy();
    (0, import_vitest.expect)(u.category).toBe("no_furnace_intermediate");
    (0, import_vitest.expect)(import_types.REASON_CATEGORY_LABELS[u.category]).toBe("\u65E0\u7194\u7089\u4E2D\u95F4\u4EA7\u7269");
  });
});
(0, import_vitest.describe)("\u5206\u652F\u62E9\u4F18\u4EE3\u4EF7 (branchCostOf / compareBranchCost)", () => {
  const base = { unreachableTotal: 0, leafTotal: 0, craftTriggers: 0 };
  (0, import_vitest.it)("\u5B58\u5728\u5B8C\u5168\u53EF\u8FBE\u5206\u652F\u65F6\uFF0C\u7EDD\u4E0D\u56E0\u4E0D\u53EF\u8FBE\u5206\u652F\u53F6\u5B50\u66F4\u5C11\u800C\u9009\u5B83\uFF08\u907F\u514D\u6574\u5355\u8BEF\u62D2\uFF09", () => {
    const unreachableBranch = (0, import_CraftPlanner.branchCostOf)(base, { unreachableTotal: 1, leafTotal: 1, craftTriggers: 0 });
    const reachableBranch = (0, import_CraftPlanner.branchCostOf)(base, { unreachableTotal: 0, leafTotal: 10, craftTriggers: 4 });
    (0, import_vitest.expect)((0, import_CraftPlanner.compareBranchCost)(reachableBranch, unreachableBranch)).toBeLessThan(0);
  });
  (0, import_vitest.it)("\u53EF\u8FBE\u6027\u76F8\u540C\u65F6\u4ECD\u4EE5\u9700\u91C7\u96C6\u53F6\u5B50\u91CF\u4E3A\u4E3B\u4EE3\u4EF7\uFF08Req 3.3 \u4E0D\u53D8\uFF09", () => {
    const cheap = (0, import_CraftPlanner.branchCostOf)(base, { unreachableTotal: 0, leafTotal: 9, craftTriggers: 99 });
    const expensive = (0, import_CraftPlanner.branchCostOf)(base, { unreachableTotal: 0, leafTotal: 18, craftTriggers: 1 });
    (0, import_vitest.expect)((0, import_CraftPlanner.compareBranchCost)(cheap, expensive)).toBeLessThan(0);
  });
  (0, import_vitest.it)("\u91C7\u96C6\u91CF\u76F8\u540C\u65F6\u9009\u5408\u6210\u89E6\u53D1\u6B21\u6570\u66F4\u5C11\u7684\u94FE\uFF08\u771F\u670D\u5F80\u8FD4\u66F4\u5C11\u3001\u66F4\u5FEB\uFF09", () => {
    const fewTriggers = (0, import_CraftPlanner.branchCostOf)(base, { unreachableTotal: 0, leafTotal: 64, craftTriggers: 20 });
    const manyTriggers = (0, import_CraftPlanner.branchCostOf)(base, { unreachableTotal: 0, leafTotal: 64, craftTriggers: 360 });
    (0, import_vitest.expect)((0, import_CraftPlanner.compareBranchCost)(fewTriggers, manyTriggers)).toBeLessThan(0);
    (0, import_vitest.expect)((0, import_CraftPlanner.compareBranchCost)(fewTriggers, fewTriggers)).toBe(0);
  });
});
