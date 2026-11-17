// 26.1 protocol.json → 26.3 protocol.json 的手术补丁。
// 依据：ViaFabricPlus-Mortis 4.4.15（D:\SSS\ViaFabricPlus-ver-1.21.11）源码 +
// decomp 的 ViaVersion 5.12.2（v26_1to26_2 / v26_2to26_3 协议层）。
// 包 id 移位锚点已与 mc-data 26.1 实际包表核对（explosion=36、add_resource_pack=81、
// store_cookie=120、pong=45、arm_animation=63）。

'use strict'

// 把 mapper 的 mappings 重写为新 id 表。
// anchor：{ after: 包名, add: [新包名...] } 或 { remove: 包名 }
function remapPackets (mappings, ops) {
  // 现 id → 名（升序）
  const rows = Object.entries(mappings).map(([hex, name]) => [parseInt(hex), name]).sort((a, b) => a[0] - b[0])
  const out = []
  for (const [id, name] of rows) {
    const op = ops.find(o => o.after === name)
    if (op) {
      out.push([id, name])
      for (const added of op.add) out.push([id + 1, added])
    } else if (ops.some(o => o.remove === name)) {
      // 跳过被删除的包
    } else {
      out.push([id, name])
    }
  }
  // 重新编号：插入/删除后依序重排
  const next = {}
  out.forEach(([id, name], index) => { next[index] = name })
  return next
}

function rewritePacketMapper (types, ops) {
  const packetDef = types.packet
  const mapperNode = packetDef[1][0].type[1]
  mapperNode.mappings = remapPackets(mapperNode.mappings, ops)
}

// ---------- 组件表 ----------

// 26.3 新组件的结构定义（protodef 术语，来自 decomp StructuredDataKeys26_3 + 各数据类）
// Via 的 ResolvableInt 在写侧永远 direct=true（i32/f32），26.3 服务器同款 → 直接定长类型
const RESOLVABLE_INT = 'i32'
const RESOLVABLE_FLOAT = 'f32'

const NEW_COMPONENT_TYPES = {
  sulfur_cube_content: 'ItemStackTemplate263', // 26.2 加：item template（26.1 已有 ItemStackTemplate）
  provides_pottery_pattern: 'varint',
  block_transformer: 'varint',
  compostable: 'resolvableInt263',
  villager_food: 'varint',
  cooking_fuel: ['container', [{ name: 'burnTime', type: 'resolvableInt263' }, { name: 'speed', type: 'resolvableFloat263' }]],
  brewing_fuel: ['container', [{ name: 'uses', type: 'resolvableInt263' }, { name: 'speed', type: 'resolvableFloat263' }]],
  mob_visibility: ['container', [{ name: 'holders', type: 'varint' }, { name: 'visibility', type: 'f32' }]],
  sign_text_front: 'SignText263',
  sign_text_back: 'SignText263',
  waxed: 'void',
  cushion_color: 'varint',
  attack_animation: ['container', [{ name: 'type', type: 'varint' }, { name: 'duration', type: 'varint' }]],
  interact_animation: ['container', [{ name: 'type', type: 'varint' }, { name: 'duration', type: 'varint' }]]
}

// 26.3 删除的组件（data 仍在 switch 里没关系，映射表删掉即可）
const REMOVED_COMPONENTS_263 = ['map_color', 'swing_animation']

// 26.3 改版组件 → 新结构
const CHANGED_COMPONENTS_263 = {
  pot_decorations: 'PotDecorations263',
  provides_trim_material: 'TrimMaterial263',
  trim_material: 'TrimMaterial263'
}

function patchSlotComponentTypes (protocol, components263) {
  const T = protocol.types
  // SlotComponentType = ["mapper", { type, mappings }]
  const mapperNode = T.SlotComponentType[1]
  const next = {}
  components263.names263.forEach((name, id) => { next[id] = name })
  mapperNode.mappings = next

  // 新结构类型注册进顶层 types
  T.resolvableInt263 = RESOLVABLE_INT
  T.resolvableFloat263 = RESOLVABLE_FLOAT
  T.SignText263 = ['container', [
    { name: 'messages', type: ['array', { count: 4, type: 'anonymousNbt' }] },
    { name: 'filteredMessages', type: ['option', ['array', { count: 4, type: 'anonymousNbt' }]] },
    { name: 'dye', type: 'varint' },
    { name: 'hasGlowing', type: 'bool' }
  ]]
  T.PotDecorations263 = ['array', { count: 4, type: ['option', 'ItemStackTemplate263'] }]
  T.TrimMaterial263 = ['container', [
    { name: 'material', type: 'string' },
    { name: 'description', type: 'anonymousNbt' }
  ]]
  T.ItemStackTemplate263 = T.ItemStackTemplate // 26.1 已有同构
  T.ViaSkip = 'void'

  // SlotComponent 的 switch fields：删旧、换新、补新
  const slotFields = T.SlotComponent[1]
  const dataField = slotFields.find(f => f.name === 'data')
  const switchNode = dataField.type[1] // ["switch", { compareTo, fields }]
  for (const name of REMOVED_COMPONENTS_263) delete switchNode.fields[name]
  for (const [name, type] of Object.entries(CHANGED_COMPONENTS_263)) switchNode.fields[name] = type
  for (const [name, type] of Object.entries(NEW_COMPONENT_TYPES)) {
    if (!(name in switchNode.fields)) switchNode.fields[name] = type
  }
}

// ---------- 字段级手术 ----------

function patchFieldTypes (protocol) {
  const login = protocol.login.toClient.types
  const play = protocol.play.toClient.types
  const playServer = protocol.play.toServer.types

  // 26.2：login success 尾部 + sessionId UUID
  const success = login.packet_success
  if (!success[1].some(f => f.name === 'sessionId')) {
    success[1].push({ name: 'sessionId', type: 'UUID' })
  }

  // 26.2：play LOGIN 尾部 + encrypted BOOLEAN
  const loginFields = play.packet_login[1]
  if (!loginFields.some(f => f.name === 'encrypted')) loginFields.push({ name: 'encrypted', type: 'bool' })

  // 26.3：LOGIN/RESPAWN gamemode BYTE→VARINT、previousGamemode→OPTIONAL_VARINT
  for (const def of [play.packet_login, play.packet_respawn]) {
    const list = def[1]
    for (const f of list) {
      if (f.name === 'gamemode') f.type = 'varint'
      if (f.name === 'previousGamemode') f.type = ['option', 'varint']
    }
  }

  // 26.3：player_chat filterMask i64 数组 → bitset
  const chatFields = play.packet_player_chat[1]
  const filterMask = chatFields.find(f => f.name === 'filterMask')
  if (filterMask) filterMask.type = 'bitset'

  // 26.3：update_light / map_chunk 光照掩码 i64 数组 → bitset
  const lightFields = play.packet_update_light[1]
  for (const f of lightFields) {
    if (['skyLightMask', 'blockLightMask', 'emptySkyLightMask', 'emptyBlockLightMask'].includes(f.name)) f.type = 'bitset'
  }
  const chunkLight = play.packet_map_chunk
  for (const f of chunkLight[1]) {
    if (['skyLightMask', 'blockLightMask', 'emptySkyLightMask', 'emptyBlockLightMask'].includes(f.name)) f.type = 'bitset'
  }

  // 26.3：move_entity_pos / pos_rot 的 onGround BOOL → flags VARINT + 插值 VARINT
  for (const name of ['packet_rel_entity_move', 'packet_entity_move_look']) {
    const list = play[name][1]
    const onGround = list.find(f => f.name === 'onGround')
    if (onGround && onGround.type === 'bool') {
      onGround.name = 'flags'
      onGround.type = 'varint'
      list.splice(list.indexOf(onGround) + 1, 0, { name: 'interpolationTicks', type: 'varint' })
    }
  }

  // 26.3：sync_entity_position 插 2 VARINT、删速度 3 DOUBLE
  const sync = play.packet_sync_entity_position[1]
  const velocityIdx = sync.findIndex(f => f.name === 'velocity')
  if (velocityIdx >= 0) {
    sync.splice(velocityIdx, 1)
    sync.unshift({ name: 'interpolationTicks', type: 'varint' }, { name: 'teleportId', type: 'varint' })
  }

  // 26.3：serverbound accept_teleportation 追加坐标
  const tp = playServer.packet_teleport_confirm[1]
  if (!tp.some(f => f.name === 'x')) {
    tp.push(
      { name: 'x', type: 'f64' },
      { name: 'y', type: 'f64' },
      { name: 'z', type: 'f64' },
      { name: 'yRot', type: 'f32' },
      { name: 'xRot', type: 'f32' }
    )
  }

  // 26.3：explosion 尾部 + BOOLEAN（Via 恒写 true，BlockItemPacketRewriter26_3.java:76；
  // 26.1 已有 playerKnockback 字段，这里用不冲突的占位名，bot 不消费该值）
  const explosion = play.packet_explosion[1]
  if (!explosion.some(f => f.name === 'extraFlag')) {
    explosion.push({ name: 'extraFlag', type: 'bool' })
  }

  // 26.3：open_sign_entity 的 isFrontText BOOL → slot VARINT
  const sign = play.packet_open_sign_entity[1]
  const front = sign.find(f => f.name === 'isFrontText')
  if (front) {
    front.name = 'slot'
    front.type = 'varint'
  }

  // 26.3：world_particles 重排（speed FLOAT → 3 FLOAT、count INT → VARINT、尾 + VARINT）
  const particles = play.packet_world_particles[1]
  const speed = particles.find(f => f.name === 'speed')
  if (speed && speed.type === 'f32') {
    speed.name = 'offsetX'
    speed.type = 'f32'
    const idx = particles.indexOf(speed)
    particles.splice(idx + 1, 0, { name: 'offsetY', type: 'f32' }, { name: 'offsetZ', type: 'f32' })
    const count = particles.find(f => f.name === 'count')
    if (count) {
      count.type = 'varint'
      particles.splice(particles.indexOf(count) + 1, 0, { name: 'extra', type: 'varint' })
    }
  }

  // 26.3：declare_recipes 尾部 + brewing_input / brewing_reagent
  const recipes = play.packet_declare_recipes
  const recipeList = recipes[1]
  if (!recipeList.some(f => f.name === 'brewingInput')) {
    const brewingEntryType = ['container', [
      { name: 'ingredient', type: 'string' },
      { name: 'slotIds', type: ['array', { countType: 'varint', type: 'varint' }] }
    ]]
    recipeList.push(
      { name: 'brewingInput', type: ['array', { countType: 'varint', type: brewingEntryType }] },
      { name: 'brewingReagent', type: ['array', { countType: 'varint', type: brewingEntryType }] }
    )
  }

  // 26.2：spectate_entity 的 entityId → optional varint（包已在 patchProtocol 改名 SPECTATOR_ACTION）
  const spectate = playServer.packet_spectator_action
  if (spectate && Array.isArray(spectate[1])) {
    const spectateTarget = spectate[1].find(f => f.name === 'target')
    if (spectateTarget) spectateTarget.type = ['option', 'varint']
  }

  // 26.3：新包定义
  play.packet_swing_animation = ['container', [
    { name: 'entityId', type: 'varint' },
    { name: 'hand', type: 'varint' },
    { name: 'swing', type: ['container', [{ name: 'type', type: 'varint' }, { name: 'duration', type: 'varint' }]] }
  ]]
  playServer.packet_punch = 'void'
  playServer.packet_via_skip = 'void'
  play.packet_via_skip = 'void'
  protocol.configuration.toClient.types.packet_via_skip = 'void'
}

// ---------- 主入口 ----------

function patchProtocol (protocol, components263) {
  // 1) 包 id 表移位（锚点已核对 mc-data 26.1 实际包表）
  const pc = protocol.play.toClient.types
  rewritePacketMapper(pc, [
    { after: 'explosion', add: ['add_transient_block'] },
    { after: 'add_resource_pack', add: ['post_effects'] },
    { after: 'store_cookie', add: ['swing_animation'] }
  ])
  const ps = protocol.play.toServer.types
  rewritePacketMapper(ps, [
    { after: 'pong', add: ['punch'] },
    { remove: 'arm_animation' }
  ])
  const cc = protocol.configuration.toClient.types
  rewritePacketMapper(cc, [
    { after: 'add_resource_pack', add: ['post_effects'] }
  ])
  // 未知结构的新包 → 空读跳过（Via 同样直接丢弃）
  pc.packet_add_transient_block = 'ViaSkip'
  pc.packet_post_effects = 'ViaSkip'
  cc.packet_post_effects = 'ViaSkip'
  // spectate_entity 改名（26.3 SPECTATOR_ACTION，结构见 patchFieldTypes）
  ps.packet_spectator_action = ps.packet_spectate_entity
  delete ps.packet_spectate_entity
  // mapper 里的包名也要同步（protodef 按 mapper 值找 packet_<name> 类型）
  const psMapper = ps.packet[1][0].type[1].mappings
  for (const [id, name] of Object.entries(psMapper)) {
    if (name === 'spectate_entity') psMapper[id] = 'spectator_action'
  }

  // 2) 字段手术 + 新包类型
  patchFieldTypes(protocol)

  // 3) 组件表 + 结构
  patchSlotComponentTypes(protocol, components263)

  return protocol
}

module.exports = { patchProtocol }
