# Upstream sources (reference only — not executed)

These TypeScript files are the **verbatim upstream sources** from the olela bot repo
(`C:\IdeaProjects\OlelaNK to kelebot3\OlelaSystem2\src-api\src\core\preparation\`).

They are kept so a future maintainer can diff the running JavaScript against the
original when the upstream changes. **The runtime never loads anything here** —
`src/craft/preparation/*.js` is the mechanically transpiled (esbuild) equivalent
that cloud-store actually runs.

Local modifications made during the port (both in the `.ts` mirrors and the `.js`
runtime files, marked with a "Ported" comment):
- `RecipeGraph`: recipes path -> `data/recipes.json`; `requiresTable` kept from raw data
- `CraftPlanner`: recipes path; `requiresTable` propagated onto craft steps
- `LeafResolver`, `ReconciliationCheck`: data paths
- `import.meta.url` / duplicate `__dirname` declarations removed for CJS
