var import_vitest = require("./vitest-shim");
var import_RecipeGraph = require("../../src/craft/preparation/RecipeGraph");
const syntheticRecipesJson = {
  meta: { version: "1.21.4" },
  tags: {
    // planks 标签：3 个木板候选（真实数据有 12 个，此处足以断言 tag 展开语义）
    "minecraft:planks": ["minecraft:oak_planks", "minecraft:spruce_planks", "minecraft:birch_planks"],
    // 嵌套标签：logs → #oak_logs → 具体原木
    "minecraft:logs": ["#minecraft:oak_logs"],
    "minecraft:oak_logs": ["minecraft:oak_log", "minecraft:oak_wood"]
  },
  recipesByResult: {
    "minecraft:iron_ingot": [
      // 反拆：iron_block → 9 iron_ingot（shapeless，应保留）
      {
        type: "shapeless",
        file: "iron_ingot_from_iron_block",
        ingredients: [{ item: "minecraft:iron_block" }],
        result: { item: "minecraft:iron_ingot", count: 9 }
      },
      // smelting / blasting 变体：应被过滤
      { type: "smelting", ingredient: { item: "minecraft:iron_ore" }, result: { item: "minecraft:iron_ingot", count: 1 } },
      { type: "blasting", ingredient: { item: "minecraft:raw_iron" }, result: { item: "minecraft:iron_ingot", count: 1 } }
    ],
    "minecraft:iron_block": [
      {
        type: "shaped",
        file: "iron_block",
        pattern: [
          [{ item: "minecraft:iron_ingot" }, { item: "minecraft:iron_ingot" }, { item: "minecraft:iron_ingot" }],
          [{ item: "minecraft:iron_ingot" }, { item: "minecraft:iron_ingot" }, { item: "minecraft:iron_ingot" }],
          [{ item: "minecraft:iron_ingot" }, { item: "minecraft:iron_ingot" }, { item: "minecraft:iron_ingot" }]
        ],
        result: { item: "minecraft:iron_block", count: 1 }
      }
    ],
    "minecraft:chest": [
      {
        type: "shaped",
        file: "chest",
        pattern: [
          [{ tag: "minecraft:planks" }, { tag: "minecraft:planks" }, { tag: "minecraft:planks" }],
          [{ tag: "minecraft:planks" }, null, { tag: "minecraft:planks" }],
          [{ tag: "minecraft:planks" }, { tag: "minecraft:planks" }, { tag: "minecraft:planks" }]
        ],
        result: { item: "minecraft:chest", count: 1 }
      }
    ],
    // charcoal 只有 smelting 配方：过滤后应不可产出
    "minecraft:charcoal": [
      { type: "smelting", ingredient: { tag: "minecraft:logs" }, result: { item: "minecraft:charcoal", count: 1 } }
    ]
  }
};
(0, import_vitest.describe)("RecipeGraph constants", () => {
  (0, import_vitest.it)("marks only shaped/shapeless as usable recipe types", () => {
    (0, import_vitest.expect)([...import_RecipeGraph.USABLE_RECIPE_TYPES].sort()).toEqual(["shaped", "shapeless"]);
  });
  (0, import_vitest.it)("filters smelting/blasting/stonecutting/transmute and other offline-incapable types (Req 1.2)", () => {
    for (const t of [
      "smelting",
      "blasting",
      "campfire_cooking",
      "smoking",
      "stonecutting",
      "smithing_transform",
      "transmute",
      "special",
      "decorated_pot"
    ]) {
      (0, import_vitest.expect)(import_RecipeGraph.FILTERED_RECIPE_TYPES.has(t)).toBe(true);
    }
    (0, import_vitest.expect)(import_RecipeGraph.FILTERED_RECIPE_TYPES.has("shaped")).toBe(false);
    (0, import_vitest.expect)(import_RecipeGraph.FILTERED_RECIPE_TYPES.has("shapeless")).toBe(false);
  });
});
(0, import_vitest.describe)("buildTagResolver (Req 1.4)", () => {
  (0, import_vitest.it)("expands a flat tag to its bare candidate item names", () => {
    const resolve = (0, import_RecipeGraph.buildTagResolver)(syntheticRecipesJson.tags);
    (0, import_vitest.expect)(resolve("minecraft:planks").sort()).toEqual(["birch_planks", "oak_planks", "spruce_planks"]);
    (0, import_vitest.expect)(resolve("planks").sort()).toEqual(["birch_planks", "oak_planks", "spruce_planks"]);
  });
  (0, import_vitest.it)("recursively expands nested tags", () => {
    const resolve = (0, import_RecipeGraph.buildTagResolver)(syntheticRecipesJson.tags);
    (0, import_vitest.expect)(resolve("minecraft:logs").sort()).toEqual(["oak_log", "oak_wood"]);
  });
  (0, import_vitest.it)("returns empty for unknown tags without throwing", () => {
    const resolve = (0, import_RecipeGraph.buildTagResolver)(syntheticRecipesJson.tags);
    (0, import_vitest.expect)(resolve("minecraft:not_a_real_tag")).toEqual([]);
  });
  (0, import_vitest.it)("prunes cyclic tag references", () => {
    const resolve = (0, import_RecipeGraph.buildTagResolver)({ "minecraft:a": ["#minecraft:b"], "minecraft:b": ["#minecraft:a", "minecraft:stone"] });
    (0, import_vitest.expect)(resolve("minecraft:a")).toEqual(["stone"]);
  });
});
(0, import_vitest.describe)("stripNamespace", () => {
  (0, import_vitest.it)("removes leading # and namespace prefix", () => {
    (0, import_vitest.expect)((0, import_RecipeGraph.stripNamespace)("minecraft:iron_ingot")).toBe("iron_ingot");
    (0, import_vitest.expect)((0, import_RecipeGraph.stripNamespace)("#minecraft:planks")).toBe("planks");
    (0, import_vitest.expect)((0, import_RecipeGraph.stripNamespace)("iron_ingot")).toBe("iron_ingot");
  });
});
(0, import_vitest.describe)("RecipeGraph (injected synthetic recipes)", () => {
  const graph = new import_RecipeGraph.RecipeGraph({ recipesJson: syntheticRecipesJson });
  (0, import_vitest.it)("retains only shaped/shapeless recipes and filters the rest (Req 1.2)", () => {
    const ironRecipes = graph.getRecipesFor("iron_ingot");
    (0, import_vitest.expect)(ironRecipes).toHaveLength(1);
    (0, import_vitest.expect)(ironRecipes[0].type).toBe("shapeless");
    (0, import_vitest.expect)(graph.stats.filteredRecipeCount).toBe(3);
    (0, import_vitest.expect)(graph.stats.usableRecipeCount).toBe(3);
  });
  (0, import_vitest.it)("does not make items producible when only filtered recipes exist (Req 1.2)", () => {
    (0, import_vitest.expect)(graph.isProducible("charcoal")).toBe(false);
    (0, import_vitest.expect)(graph.getRecipesFor("charcoal")).toEqual([]);
    (0, import_vitest.expect)(graph.isProducible("iron_block")).toBe(true);
    (0, import_vitest.expect)(graph.isProducible("chest")).toBe(true);
  });
  (0, import_vitest.it)("exposes the iron_block reverse-craft under recipesByResult['iron_ingot'] (Req 1.2)", () => {
    const ironRecipes = graph.getRecipesFor("iron_ingot");
    const reverse = ironRecipes.find((r) => r.inputs.some((inp) => inp.names.includes("iron_block")));
    (0, import_vitest.expect)(reverse).toBeTruthy();
    (0, import_vitest.expect)(reverse.result.count).toBe(9);
    (0, import_vitest.expect)(reverse.inputs).toHaveLength(1);
    (0, import_vitest.expect)(reverse.inputs[0].names).toEqual(["iron_block"]);
    (0, import_vitest.expect)(reverse.inputs[0].count).toBe(1);
  });
  (0, import_vitest.it)("expands a tag ingredient into its candidate set and merges identical slots (Req 1.4)", () => {
    const chestRecipes = graph.getRecipesFor("chest");
    (0, import_vitest.expect)(chestRecipes).toHaveLength(1);
    const chest = chestRecipes[0];
    (0, import_vitest.expect)(chest.inputs).toHaveLength(1);
    (0, import_vitest.expect)(chest.inputs[0].count).toBe(8);
    (0, import_vitest.expect)(chest.inputs[0].names.sort()).toEqual(["birch_planks", "oak_planks", "spruce_planks"]);
  });
});
(0, import_vitest.describe)("RecipeGraph (real recipes.json smoke test)", () => {
  const graph = new import_RecipeGraph.RecipeGraph();
  (0, import_vitest.it)("loads the 1.21.4 recipe catalog against the production 1.21.11 registry", () => {
    (0, import_vitest.expect)(graph.stats.sourceVersion).toBe("1.21.4");
    (0, import_vitest.expect)(graph.stats.usableRecipeCount).toBe(931);
    (0, import_vitest.expect)(graph.stats.filteredRecipeCount).toBe(418);
    (0, import_vitest.expect)(graph.stats.producibleItemCount).toBe(809);
    (0, import_vitest.expect)(graph.stats.droppedUnknownResult).toBe(1);
    (0, import_vitest.expect)(graph.getRecipesFor("chain")).toEqual([]);
  });
  (0, import_vitest.it)("contains the iron_block \u2192 9 iron_ingot reverse-craft (Req 1.2)", () => {
    const reverse = graph.getRecipesFor("iron_ingot").find((r) => r.type === "shapeless" && r.inputs.some((inp) => inp.names.includes("iron_block")));
    (0, import_vitest.expect)(reverse).toBeTruthy();
    (0, import_vitest.expect)(reverse.result.count).toBe(9);
  });
  (0, import_vitest.it)("expands the chest planks tag into 12 candidates with slot count 8 (Req 1.4)", () => {
    const chest = graph.getRecipesFor("chest")[0];
    (0, import_vitest.expect)(chest).toBeTruthy();
    const planksSlot = chest.inputs.find((inp) => inp.count === 8);
    (0, import_vitest.expect)(planksSlot).toBeTruthy();
    (0, import_vitest.expect)(planksSlot.names.length).toBe(12);
    (0, import_vitest.expect)(planksSlot.names).toContain("oak_planks");
  });
  (0, import_vitest.it)("repairs every converted dye-wool recipe with the base wool required by the executor", () => {
    const woolColors = [
      "white",
      "orange",
      "magenta",
      "light_blue",
      "yellow",
      "lime",
      "pink",
      "gray",
      "light_gray",
      "cyan",
      "purple",
      "blue",
      "brown",
      "green",
      "red",
      "black"
    ];
    for (const color of woolColors) {
      const resultName = `${color}_wool`;
      const dyeRecipe = graph.getRecipesFor(resultName).find((recipe) => recipe.id === `dye_${resultName}`);
      (0, import_vitest.expect)(dyeRecipe, resultName).toBeTruthy();
      (0, import_vitest.expect)(dyeRecipe.inputs).toContainEqual({ names: [`${color}_dye`], count: 1 });
      (0, import_vitest.expect)(dyeRecipe.inputs).toContainEqual({
        names: [resultName === "black_wool" ? "blue_wool" : "black_wool"],
        count: 1
      });
    }
  });
  (0, import_vitest.it)("keeps the real lead recipe at four string plus one slime ball", () => {
    const lead = graph.getRecipesFor("lead").find((recipe) => recipe.id === "lead");
    (0, import_vitest.expect)(lead).toBeTruthy();
    (0, import_vitest.expect)(lead.result).toEqual({ name: "lead", count: 2 });
    (0, import_vitest.expect)(lead.inputs).toContainEqual({ names: ["string"], count: 4 });
    (0, import_vitest.expect)(lead.inputs).toContainEqual({ names: ["slime_ball"], count: 1 });
    (0, import_vitest.expect)(lead.inputs).not.toContainEqual({ names: ["string"], count: 5 });
  });
});
(0, import_vitest.describe)("completeKnownRecipeInputs", () => {
  (0, import_vitest.it)("does not alter a complete shaped recipe", () => {
    const recipe = {
      id: "lead",
      type: "shaped",
      result: { name: "lead", count: 2 },
      inputs: [
        { names: ["string"], count: 4 },
        { names: ["slime_ball"], count: 1 }
      ]
    };
    (0, import_vitest.expect)((0, import_RecipeGraph.completeKnownRecipeInputs)(recipe)).toBe(recipe);
  });
  (0, import_vitest.it)("does not alter an unrelated one-input shapeless recipe", () => {
    const recipe = {
      id: "white_dye",
      type: "shapeless",
      result: { name: "white_dye", count: 1 },
      inputs: [{ names: ["bone_meal"], count: 1 }]
    };
    (0, import_vitest.expect)((0, import_RecipeGraph.completeKnownRecipeInputs)(recipe)).toBe(recipe);
  });
});
(0, import_vitest.describe)("narrowToExecutableNames\uFF08\u539F\u6599\u5019\u9009\u6309\u6267\u884C\u5668\u771F\u5B9E\u80FD\u529B\u6536\u7A84\uFF09", () => {
  const oakLogsTag = ["oak_log", "oak_wood", "stripped_oak_log", "stripped_oak_wood"];
  (0, import_vitest.it)("oak_planks \u7684 #oak_logs \u5019\u9009\u6536\u7A84\u5230 minecraft-data \u771F\u6B63\u7F16\u7801\u7684 oak_log", () => {
    (0, import_vitest.expect)((0, import_RecipeGraph.narrowToExecutableNames)("oak_planks", oakLogsTag)).toEqual(["oak_log"]);
  });
  (0, import_vitest.it)("\u4EA7\u7269\u5728 minecraft-data \u91CC\u67E5\u4E0D\u5230\u914D\u65B9\u65F6 fail-open\uFF08\u4FDD\u6301\u539F\u5019\u9009\u96C6\uFF09", () => {
    (0, import_vitest.expect)((0, import_RecipeGraph.narrowToExecutableNames)("definitely_not_an_item", oakLogsTag)).toEqual(oakLogsTag);
  });
  (0, import_vitest.it)("\u5019\u9009\u672C\u8EAB\u90FD\u53EF\u7528\u65F6\u539F\u6837\u4FDD\u7559\uFF1B\u5355\u5019\u9009\u4E0D\u5904\u7406", () => {
    (0, import_vitest.expect)((0, import_RecipeGraph.narrowToExecutableNames)("oak_planks", ["oak_log"])).toEqual(["oak_log"]);
    (0, import_vitest.expect)((0, import_RecipeGraph.narrowToExecutableNames)("stick", ["oak_planks", "birch_planks"])).toEqual(["oak_planks", "birch_planks"]);
  });
  (0, import_vitest.it)("\u4EA4\u96C6\u4E3A\u7A7A\u65F6 fail-open\uFF0C\u4E0D\u8FD4\u56DE\u7A7A\u6570\u7EC4", () => {
    const bogus = ["diamond", "emerald"];
    (0, import_vitest.expect)((0, import_RecipeGraph.narrowToExecutableNames)("oak_planks", bogus)).toEqual(bogus);
  });
  (0, import_vitest.it)("\u6536\u7A84\u540E\u7684\u5019\u9009\u96C6\u4F1A\u4F53\u73B0\u5728\u771F\u5B9E RecipeGraph \u7684 oak_planks \u914D\u65B9\u8F93\u5165\u91CC", () => {
    const real = new import_RecipeGraph.RecipeGraph();
    const recipes = real.getRecipesFor("oak_planks");
    (0, import_vitest.expect)(recipes.length).toBeGreaterThan(0);
    const slot = recipes[0].inputs[0];
    (0, import_vitest.expect)(slot.names).toContain("oak_log");
    (0, import_vitest.expect)(slot.names).not.toContain("stripped_oak_log");
  });
});
