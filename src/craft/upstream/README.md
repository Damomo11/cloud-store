# Adapted upstream preparation sources

The port began from the olela bot snapshot supplied on 2026-11-02:

- Preparation TypeScript: `olelabot-full/OlelaSystem2/src-api/src/core/preparation/`.
- The initial executor and bot-helper port came from
  `olelabot-full/node-bot/src/plugins/`; those copied runtime files were removed
  after the local warehouse executor replaced them.

The files in this directory are adapted reference sources. Cloud Store executes
the CommonJS files in `src/craft/preparation/`, with the local inventory executor
in `src/craft/inventory-executor.js` under the durable warehouse controller.
Cloud Store does not load these TypeScript files. The JavaScript preparation files began
as esbuild output and also contain local runtime edits. The TypeScript files
retain some upstream ESM path setup, collection logic, and historical design
comments, so rebuilding the entire directory without reviewing those differences
would overwrite Cloud Store behavior.

Local adaptations include:

- `RecipeGraph`: production recipes come from the configured Minecraft version's
  `minecraft-data` registry, using each concrete shaped/shapeless recipe's inputs
  and grid size. Graphs are cached by version. The historical 1.21.4
  `data/recipes.json` remains an explicit `recipesPath`/`recipesJson` test seam;
  it does not supplement the production catalog. Legacy tag normalization and
  converted wool-recipe repair remain for those fixtures.
- `recipe-outputs.js` supplies gross outputs shared by the live graph and inventory
  executor. It resolves known vanilla bucket/bottle returns through the active
  registry, enriches Mineflayer's output grid and recipe delta before crafting,
  and rejects unknown filled-container returns before clicks. Planned steps carry
  these outputs so quota checks and recovery use the same container counts.
- `CraftPlanner` and `types`: `requiresTable` is carried through recipe expansion,
  branch cloning, and finalized steps. Each planned input records the single
  ingredient selected during planning, so reservation and execution consume the
  same materials rather than reselecting from an abstract tag candidate list.
  Returned containers become available for subsequent steps in the same plan.
  An existing template can seed its own duplication recipe; later triggers reuse
  one of the preceding outputs and are counted by net gain.
- `versionGuard`: the default preparation registry is 1.21.11, matching the supplied
  Cloud Store configuration. Production recipe planning accepts `server.version`.
- `LeafResolver`, `ReconciliationCheck`, and the planner's fallback resource map:
  runtime paths point to Cloud Store's `data/` directory. CommonJS runtime files
  use Node's `__dirname` rather than the upstream `import.meta.url` declarations.
- The Cloud Store adapter replaces upstream HTTP station, inventory, and reporting
  seams with warehouse database access, craft reservations, and local event handling.
  Materials and outputs belong to the selected cloud warehouse. Only synthesis
  runs here; collection and hauling capabilities retained in the planner are not
  dispatched. Stock inside shulker boxes is excluded from crafting for now.
- Physical operations whose outcome is uncertain keep their affected assets
  blocked for recovery instead of making them immediately available again.

`test/craft/recipeGraph.test.js` and `craftPlanner.forwardCraft.test.js` retain
upstream regression scenarios against the explicit historical JSON snapshot.
`recipeVersion.test.js` covers the production registry and the local runner shim.
`npm test` includes these suites; `npm run check` recursively syntax-checks all
JavaScript files in `src/` and `scripts/`.
