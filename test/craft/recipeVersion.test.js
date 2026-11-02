'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { RecipeGraph, getRecipeGraph, resetRecipeGraphForTest } = require('../../src/craft/preparation/RecipeGraph')
const { CraftPlanner } = require('../../src/craft/preparation/CraftPlanner')
const { expect } = require('./vitest-shim')

test('ordinary ported it callbacks register and propagate a failing assertion', () => {
  const child = spawnSync(process.execPath, ['-e',
    `const { it } = require(${JSON.stringify(require.resolve('./vitest-shim'))}); it('registered', () => { throw new Error('registered assertion'); });`
  ], { encoding: 'utf8' })
  assert.equal(child.status, 1, child.stdout + child.stderr)
  assert.match(child.stdout, /registered assertion/)
})

test('ported not.toContain checks arrays and strings in both directions', () => {
  assert.doesNotThrow(() => expect(['oak_log']).not.toContain('birch_log'))
  assert.doesNotThrow(() => expect('oak_log').not.toContain('birch'))
  assert.throws(() => expect(['oak_log']).not.toContain('oak_log'), assert.AssertionError)
  assert.throws(() => expect('oak_log').not.toContain('oak'), assert.AssertionError)
})

test('production copper sword uses two copper ingots, one stick and a workbench', () => {
  const graph = new RecipeGraph({ version: '1.21.11' })
  assert.equal(graph.stats.sourceVersion, '1.21.11')
  const recipe = graph.getRecipesFor('copper_sword')[0]
  assert.ok(recipe, 'the configured registry must supply post-1.21.4 recipes')
  assert.deepEqual(recipe.result, { name: 'copper_sword', count: 1 })
  assert.deepEqual(recipe.inputs, [
    { names: ['copper_ingot'], count: 2 },
    { names: ['stick'], count: 1 }
  ])
  assert.equal(recipe.requiresTable, true)
  const plan = new CraftPlanner(graph).plan('copper_sword', 1, {
    available: { copper_ingot: 2, stick: 1 }
  })
  assert.equal(plan.ok, true)
  assert.deepEqual(plan.collectGaps, [])
  assert.equal(plan.craftSteps.length, 1)
  assert.equal(plan.craftSteps[0].requiresTable, true)
})

test('configured recipe versions do not share a cached graph', () => {
  resetRecipeGraphForTest()
  const oldGraph = getRecipeGraph('1.21.4')
  const currentGraph = getRecipeGraph('1.21.11')
  assert.equal(oldGraph.isProducible('copper_sword'), false)
  assert.equal(currentGraph.isProducible('copper_sword'), true)
  assert.notEqual(oldGraph, currentGraph)
  assert.equal(getRecipeGraph('1.21.11'), currentGraph)
})

test('production lead recipe consumes five string and no obsolete slime ball', () => {
  const graph = new RecipeGraph({ version: '1.21.11' })
  const recipe = graph.getRecipesFor('lead')[0]
  assert.deepEqual(recipe.result, { name: 'lead', count: 2 })
  assert.deepEqual(recipe.inputs, [{ names: ['string'], count: 5 }])
})

test('production template duplication reuses its seed and reaches the requested total', () => {
  const { planToCraftCommand } = require('../../src/craft')
  for (const version of ['1.21.4', '1.21.11']) {
    for (const [name, material] of [
      ['netherite_upgrade_smithing_template', 'netherrack'],
      ['sentry_armor_trim_smithing_template', 'cobblestone']
    ]) {
      for (const quantity of [2, 3]) {
        const available = { [name]: 1, diamond: 7 * (quantity - 1), [material]: quantity - 1 }
        const result = planToCraftCommand({ item: name, quantity, available,
          config: { server: { version }, craft: { table: { x: 0, y: 64, z: 0 } } } })
        assert.equal(result.ok, true, `${version} ${name} target ${quantity}: ${result.reason}`)
        assert.deepEqual(result.plan.collectGaps, [])
        assert.equal(result.plan.craftSteps.length, 1)
        assert.equal(result.plan.craftSteps[0].times, quantity - 1)
        assert.equal(result.plan.inventoryUses.find(input => input.name === name).quantity, 1)
        const physical = { ...available }
        for (const step of result.plan.craftSteps) for (let trigger = 0; trigger < step.times; trigger++) {
          for (const input of step.inputs) {
            const inputName = input.names[0]
            assert.ok(physical[inputName] >= input.count, `trigger ${trigger} lacks ${inputName}`)
            physical[inputName] -= input.count
          }
          for (const output of step.outputs) physical[output.name] = (physical[output.name] || 0) + output.count
        }
        assert.equal(physical[name], quantity)
        assert.equal(physical.diamond, 0)
        assert.equal(physical[material], 0)
      }
    }
  }
})

test('production recipes and planned steps retain returned containers', () => {
  for (const version of ['1.21.4', '1.21.11']) {
    const graph = new RecipeGraph({ version })
    const honey = graph.getRecipesFor('honey_block')[0]
    const outputs = [{ name: 'honey_block', count: 1 }, { name: 'glass_bottle', count: 4 }]
    assert.deepEqual(honey.outputs, outputs)
    const plan = new CraftPlanner(graph).plan('honey_block', 1, { available: { honey_bottle: 4 } })
    assert.equal(plan.ok, true)
    assert.deepEqual(plan.craftSteps[0].outputs, outputs)
    assert.deepEqual(graph.getRecipesFor('cake')[0].outputs, [{ name: 'cake', count: 1 }, { name: 'bucket', count: 3 }])
  }
})

test('executable recipes retain their own ingredient choices and crafting-grid size', () => {
  const graph = new RecipeGraph({ version: '1.21.11' })
  const chest = graph.getRecipesFor('chest')
  assert.ok(chest.some(recipe => recipe.inputs.length === 1 && recipe.inputs[0].count === 8 && recipe.inputs[0].names[0] === 'oak_planks'))
  assert.ok(chest.every(recipe => recipe.requiresTable))
  assert.equal(graph.getRecipesFor('stick').find(recipe => recipe.result.count === 4).requiresTable, false)
  assert.equal(graph.getRecipesFor('oak_planks')[0].requiresTable, false)
  assert.ok(graph.getRecipesFor('iron_ingot').every(recipe =>
    recipe.inputs.every(input => !input.names.includes('iron_ore') && !input.names.includes('raw_iron'))))
})

test('a registry recipe with an unknown input cannot become a partial free recipe', () => {
  const registry = {
    version: { minecraftVersion: 'fixture' },
    items: { 1: { name: 'stick' }, 2: { name: 'oak_planks' } },
    itemsByName: { stick: { id: 1 }, oak_planks: { id: 2 } },
    recipes: { 1: [{ ingredients: [2, 999], result: { id: 1, count: 4 } }] }
  }
  assert.deepEqual(new RecipeGraph({ registry }).getRecipesFor('stick'), [])
})

test('unsupported configured versions fail instead of silently using another catalog', () => {
  assert.throws(() => new RecipeGraph({ version: 'invalid-version' }), /version|版本|registry/i)
})
