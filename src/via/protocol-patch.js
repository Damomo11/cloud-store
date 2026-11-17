// 26.1 protocol.json → 26.3 protocol.json 的手术补丁。
// 依据：ViaFabricPlus-Mortis 4.4.15（D:\SSS\ViaFabricPlus-ver-1.21.11）源码 +
// decomp 的 ViaVersion 5.12.2（v26_1to26_2 / v26_2to26_3 协议层）+ 26.3 客户端反编译。
// 包 id 移位已与 Via ClientboundPackets26_3/ServerboundPackets26_3 枚举逐 id 对齐验证
//（144 clientbound / 69 serverbound 全等，2026-11 审计）。
//
// 2026-11 审计修复记录（真值 = 26.3 客户端反编译 + Via 写侧双证）：
//   - rel_entity_move/entity_move_look：properties(onGround|stepCount<<1) 在 delta 之前
//     （旧补丁顺序反了，典型包总长恰好相同 → 不炸但 dX/dY/dZ 全是乱值）
//   - gamemode/previousGamemode 在 SpawnInfo 容器里（旧补丁在 packet_login 顶层找，no-op）
//   - previousGamemode 是单 varint（0=无，否则 id+1），不是 option
//   - world_particles 旧补丁按 speed/count 找字段（mc-data 26.1 叫 velocityOffset/amount），
//     整个重排是 no-op，现按真值全量重写
//   - protodef 没有 bitset 类型（旧补丁引用后一遇光照包就炸），现注册 buffer 版实现
//   - 'cushion_color' 实际组件名是 'cushion/color'；trim 的键是 'trim' 不是 'trim_material'
//   - compostable/cooking_fuel/brewing_fuel 的数值是 ResolvableInt/Float（bool+i32/f32 或引用串）
//   - spectator_action.target 是单 varint（0=取消，否则 id+1），不是 option
//   - post_effects = varint 数量 + N 个 identifier（旧补丁猜的单 varint 只在 count=0 时碰巧对）

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

// 26.3 新组件的结构定义（protodef 术语，来自 26.3 客户端反编译 + Via StructuredDataKeys）
// ResolvableInt/Float = ByteBufCodecs.either：bool true→直接值 / false→registry 引用字符串
const RESOLVABLE_INT263 = ['container', [
  { name: 'direct', type: 'bool' },
  { name: 'value', type: ['switch', { compareTo: 'direct', fields: { true: 'i32', false: 'string' } }] }
]]
const RESOLVABLE_FLOAT263 = ['container', [
  { name: 'direct', type: 'bool' },
  { name: 'value', type: ['switch', { compareTo: 'direct', fields: { true: 'f32', false: 'string' } }] }
]]


// trim Holder：varint 0=inline，非 0=registry id（ByteBufCodecs.holder 语义，与原生 registryEntryHolder 一致）
const TRIM_MATERIAL_HOLDER = ['registryEntryHolder', {
  baseName: 'materialId',
  otherwise: {
    name: 'materialData',
    type: ['container', [
      { name: 'paletteId', type: 'string' },
      { name: 'description', type: 'anonymousNbt' }
    ]]
  }
}]
const TRIM_PATTERN_HOLDER = ['registryEntryHolder', {
  baseName: 'patternId',
  otherwise: {
    name: 'patternData',
    type: ['container', [
      { name: 'assetId', type: 'string' },
      { name: 'description', type: 'anonymousNbt' },
      { name: 'decal', type: 'bool' }
    ]]
  }
}]

const NEW_COMPONENT_TYPES = {
  sulfur_cube_content: 'ItemStackTemplate263', // 26.3 新增：item template（26.1 已有 ItemStackTemplate，同构）
  provides_pottery_pattern: 'varint',
  block_transformer: 'varint',
  compostable: 'resolvableInt263',
  villager_food: 'varint',
  cooking_fuel: ['container', [{ name: 'burnTime', type: 'resolvableInt263' }, { name: 'speed', type: 'resolvableFloat263' }]],
  brewing_fuel: ['container', [{ name: 'uses', type: 'resolvableInt263' }, { name: 'speed', type: 'resolvableFloat263' }]],
  mob_visibility: ['container', [
    { name: 'holders', type: ['registryEntryHolderSet', { base: { name: 'tag', type: 'string' }, otherwise: { name: 'ids', type: 'varint' } }] },
    { name: 'visibility', type: 'f32' }
  ]],
  sign_text_front: 'SignText263',
  sign_text_back: 'SignText263',
  waxed: 'void',
  'cushion/color': 'varint', // 注意组件真名带斜杠（Via identifiers 解码），键必须一致
  attack_animation: ['container', [{ name: 'type', type: 'varint' }, { name: 'duration', type: 'varint' }]],
  interact_animation: ['container', [{ name: 'type', type: 'varint' }, { name: 'duration', type: 'varint' }]]
}

// 26.3 删除的组件（data 仍在 switch 里没关系，映射表删掉即可）
const REMOVED_COMPONENTS_263 = ['map_color', 'swing_animation']

// 26.3 改版组件 → 新结构
// 注意键名：mc-data 26.1 的 trim 组件键是 'trim'（不是 trim_material），
// cushion 的键是 'cushion/color'（2026-11 审计：旧补丁用错键名，trim 挂旧结构、cushion 必炸）
const CHANGED_COMPONENTS_263 = {
  pot_decorations: 'PotDecorations263',
  provides_trim_material: 'TrimMaterialHolder263',
  trim: 'Trim263'
}

function patchSlotComponentTypes (protocol, components263) {
  const T = protocol.types
  // SlotComponentType = ["mapper", { type, mappings }]
  const mapperNode = T.SlotComponentType[1]
  const next = {}
  components263.names263.forEach((name, id) => { next[id] = name })
  mapperNode.mappings = next

  // 新结构类型注册进顶层 types
  T.resolvableInt263 = RESOLVABLE_INT263
  T.resolvableFloat263 = RESOLVABLE_FLOAT263
  T.SignText263 = ['container', [
    { name: 'messages', type: ['array', { count: 4, type: 'anonymousNbt' }] },
    { name: 'filteredMessages', type: ['option', ['array', { count: 4, type: 'anonymousNbt' }]] },
    { name: 'dye', type: 'varint' },
    { name: 'hasGlowing', type: 'bool' }
  ]]
  T.PotDecorations263 = ['array', { count: 4, type: ['option', 'ItemStackTemplate263'] }]
  T.TrimMaterialHolder263 = TRIM_MATERIAL_HOLDER
  T.Trim263 = ['container', [
    { name: 'material', type: TRIM_MATERIAL_HOLDER },
    { name: 'pattern', type: TRIM_PATTERN_HOLDER }
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

  // 26.3：instrument inline 分支 +1 个 durabilityDamage varint
  //（vanilla Instrument.DIRECT_STREAM_CODEC = sound, f32, f32, VAR_INT, description）
  const instrumentData = T.InstrumentData
  if (instrumentData) {
    const fields = instrumentData[1]
    if (!fields.some(f => f.name === 'durabilityDamage')) {
      const descIdx = fields.findIndex(f => f.name === 'description')
      fields.splice(descIdx >= 0 ? descIdx : fields.length, 0, { name: 'durabilityDamage', type: 'varint' })
    }
  }

  // 26.3：consumable 的 teleport_randomly 分支 +1 个 directionalParticles bool
  //（vanilla TeleportRandomlyConsumeEffect.STREAM_CODEC；death_protection 结构不变共用此类型）
  const consumeEffect = T.ItemConsumeEffect
  if (consumeEffect) {
    const sw = consumeEffect[1].find(f => f.anon === true)?.type?.[1]
    const tp = sw?.fields?.teleport_randomly
    if (Array.isArray(tp) && tp[0] === 'container') {
      if (!tp[1].some(f => f.name === 'directionalParticles')) tp[1].push({ name: 'directionalParticles', type: 'bool' })
    }
  }
}

// ---------- 字段级手术 ----------

function patchFieldTypes (protocol) {
  const login = protocol.login.toClient.types
  const play = protocol.play.toClient.types
  const playServer = protocol.play.toServer.types
  const T = protocol.types

  // protodef 没有 bitset 原生类型（审计发现旧补丁引用后一遇光照包就炸）。
  // 26.3 BIT_SET = varint 字节数 + 字节数组；输出 Buffer，由 chunk-26 的
  // ChunkColumn26.loadParsedLight 兼容层转成 BigInt 长数组喂给 prismarine-chunk。
  T.bitset = ['buffer', { countType: 'varint' }]

  // 26.2：login success 尾部 + sessionId UUID
  const success = login.packet_success
  if (!success[1].some(f => f.name === 'sessionId')) {
    success[1].push({ name: 'sessionId', type: 'UUID' })
  }

  // 26.2：play LOGIN + encrypted BOOLEAN —— 位置在 worldState 之后、enforcesSecureChat 之前
  //（26.3 真值复合序：… CommonPlayerSpawnInfo, onlineMode BOOL, enforcesSecureChat BOOL；审计 B2）
  const loginFields = play.packet_login[1]
  if (!loginFields.some(f => f.name === 'encrypted')) {
    const idx = loginFields.findIndex(f => f.name === 'enforcesSecureChat')
    loginFields.splice(idx >= 0 ? idx : loginFields.length, 0, { name: 'encrypted', type: 'bool' })
  }

  // 26.3：gamemode BYTE→VARINT、previousGamemode u8→VARINT —— 都在 SpawnInfo 容器里，
  // login 与 respawn 共用（审计 B3：旧补丁在 packet_login/respawn 顶层找字段，是 no-op）。
  // previousGamemode 线语义 = 单 varint：0=无，否则 id+1（ByteBufCodecs.OPTIONAL_VAR_INT）。
  // gamemode 保留 mapper 只换底层类型，mineflayer 消费映射后的字符串。
  const spawnInfo = play.SpawnInfo
  if (spawnInfo) {
    for (const f of spawnInfo[1]) {
      if (f.name === 'gamemode' && Array.isArray(f.type) && f.type[0] === 'mapper') f.type[1].type = 'varint'
      if (f.name === 'previousGamemode') f.type = 'varint'
    }
  }

  // 26.3：player_chat filterType==2 分支：varint 长度 i64 数组 → bitset
  const chatFields = play.packet_player_chat[1]
  const filterMaskSwitch = chatFields.find(f => f.name === 'filterTypeMask')?.type?.[1]
  if (filterMaskSwitch?.fields?.[2]) filterMaskSwitch.fields[2] = 'bitset'

  // 26.3：update_light / map_chunk 光照掩码 i64 数组 → bitset（类型已在上面注册）
  const lightFields = play.packet_update_light[1]
  for (const f of lightFields) {
    if (['skyLightMask', 'blockLightMask', 'emptySkyLightMask', 'emptyBlockLightMask'].includes(f.name)) f.type = 'bitset'
  }
  const chunkLight = play.packet_map_chunk
  for (const f of chunkLight[1]) {
    if (['skyLightMask', 'blockLightMask', 'emptySkyLightMask', 'emptyBlockLightMask'].includes(f.name)) f.type = 'bitset'
  }

  // 26.3：rel_entity_move / entity_move_look 全量重写。真值 ClientboundMoveEntityPacket$Pos/$PosRot + VecDelta：
  //   entityId varint, properties varint = onGround(bit0) | stepCount<<1,
  //   stepCount=0 → dX/dY/dZ i16；>0 → stepCount×{tickOffset varint, dX/dY/dZ i16}（PosRot 再 + yaw/pitch i8）
  // Via 写侧（EntityPacketRewriter26_3）同样把 properties 放在 delta 之前（写 [flags,3,xa,ya,za]）。
  // 旧补丁把 flags/interpolationTicks 留在 delta 之后——典型包总长恰好都是 9 字节，
  // 所以不炸但 dX/dY/dZ 全读成乱值，实体坐标静默损坏。
  // 原版服只发 stepCount=0（properties=0/1）；2/3 是 Via 风格的 1 步路径；>3 按 1 步读（余字节放弃，极罕见）。
  const moveStep = ['container', [
    { name: 'tickOffset', type: 'varint' },
    { name: 'dX', type: 'i16' },
    { name: 'dY', type: 'i16' },
    { name: 'dZ', type: 'i16' }
  ]]
  const moveLinear = ['container', [
    { name: 'dX', type: 'i16' },
    { name: 'dY', type: 'i16' },
    { name: 'dZ', type: 'i16' }
  ]]
  const moveDelta = ['switch', {
    compareTo: 'properties',
    fields: { 0: moveLinear, 1: moveLinear, 2: moveStep, 3: moveStep },
    default: moveStep
  }]
  play.packet_rel_entity_move = ['container', [
    { name: 'entityId', type: 'varint' },
    { name: 'properties', type: 'varint' },
    { name: 'delta', type: moveDelta }
  ]]
  play.packet_entity_move_look = ['container', [
    { name: 'entityId', type: 'varint' },
    { name: 'properties', type: 'varint' },
    { name: 'delta', type: moveDelta },
    { name: 'yaw', type: 'i8' },
    { name: 'pitch', type: 'i8' }
  ]]

  // 26.3：sync_entity_position 按真实结构重写。
  // 真值来源：26.3 客户端 ClientboundEntityPositionSyncPacket(id VAR_INT, PositionPath, yRot f32,
  // xRot f32, onGround bool) + PositionPath(STREAM_CODEC = varint type dispatch:
  //   0 LINEAR  → x,y,z 3×f64
  //   1 STEPPED → varint count + N×{x,y,z 3×f64, tickOffset varint}（PositionStep），
  // Stepped 的 endPosition 由最后一步推导、不上线）。
  // 旧补丁 findIndex('velocity') 永远 -1（26.1 速度字段叫 dx/dy/dz）整块是死代码，曾按
  // 26.1 结构多读 3×f64 直接读越界断线。
  // 注意：26.3 线上没有速度字段，mineflayer entities.js 的 velocity.set(packet.dx…) 会拿到
  // undefined → NaN，STEPPED 分支也没有前导 x/y/z —— 由 sync-compat.js 在运行时修复。
  play.packet_sync_entity_position = ['container', [
    { name: 'entityId', type: 'varint' },
    { name: 'pathType', type: 'varint' },
    { name: 'path', type: ['switch', {
      compareTo: 'pathType',
      fields: {
        0: ['container', [
          { name: 'x', type: 'f64' },
          { name: 'y', type: 'f64' },
          { name: 'z', type: 'f64' }
        ]],
        1: ['container', [
          { name: 'steps', type: ['array', {
            countType: 'varint',
            type: ['container', [
              { name: 'x', type: 'f64' },
              { name: 'y', type: 'f64' },
              { name: 'z', type: 'f64' },
              { name: 'tickOffset', type: 'varint' }
            ]]
          }] }
        ]]
      }
    }] },
    { name: 'yaw', type: 'f32' },
    { name: 'pitch', type: 'f32' },
    { name: 'onGround', type: 'bool' }
  ]]

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

  // 26.3：world_particles 全量重写。真值 ClientboundLevelParticlesPacket：
  //   particle(varint id+data) 移到最前、overrideLimiter/alwaysShow bool、x/y/z f64、
  //   xDist/yDist/zDist f32（= 26.1 offsetX/Y/Z）、xMaxSpeed/yMaxSpeed/zMaxSpeed f32
  //   （26.1 的单个 velocityOffset 拆成 per-axis 3 个）、count VARINT（=26.1 amount）、
  //   尾部 + randomizationType VARINT（Via 恒写 0）。
  // 审计 B10：旧补丁按 speed/count 找字段（mc-data 26.1 叫 velocityOffset/amount），整块 no-op。
  play.packet_world_particles = ['container', [
    { name: 'particle', type: 'Particle' },
    { name: 'longDistance', type: 'bool' },
    { name: 'alwaysShow', type: 'bool' },
    { name: 'x', type: 'f64' },
    { name: 'y', type: 'f64' },
    { name: 'z', type: 'f64' },
    { name: 'offsetX', type: 'f32' },
    { name: 'offsetY', type: 'f32' },
    { name: 'offsetZ', type: 'f32' },
    { name: 'maxSpeedX', type: 'f32' },
    { name: 'maxSpeedY', type: 'f32' },
    { name: 'maxSpeedZ', type: 'f32' },
    { name: 'amount', type: 'varint' },
    { name: 'randomizationType', type: 'varint' }
  ]]

  // 26.2：teams 字段重排（Via Protocol26_1To26_2:65-81 铁证）。
  // 26.1: name, flags, nameTagVisibility, collisionRule, formatting, prefix, suffix
  // 26.2+: name, prefix, suffix, nameTagVisibility, collisionRule, color(OPTIONAL_VAR_INT), flags
  // Via rewrite 的 passthrough 先写出 prefix/suffix、暂存的四件组最后 write，
  // 实测字节流（16 个 ce_* 队，color=chat 色号 0-15）逐位验证通过。
  const teamsSwitch = play.packet_teams[1].find(f => f.anon === true)?.type?.[1]
  for (const modeName of ['add', 'change']) {
    const branch = teamsSwitch?.fields?.[modeName]?.[1]
    if (!Array.isArray(branch)) continue
    const byName = name => branch.find(f => f.name === name)
    const nameF = byName('name')
    const flags = byName('flags')
    const ntv = byName('nameTagVisibility')
    const cr = byName('collisionRule')
    const formatting = byName('formatting')
    const prefix = byName('prefix')
    const suffix = byName('suffix')
    if (!nameF || !flags || !ntv || !cr || !formatting || !prefix || !suffix) continue
    if (branch[1].name === 'prefix') continue // 已是 26.2 布局
    // 原地重排：name, prefix, suffix, ntv, cr, color, flags（players 若有则留在最后）
    formatting.name = 'color'
    formatting.type = ['option', 'varint']
    const players = byName('players')
    branch.length = 0
    branch.push(nameF, prefix, suffix, ntv, cr, formatting, flags)
    if (players) branch.push(players)
  }

  // 26.3：declare_recipes 结构与 26.1 完全一致（无尾部独立字段）。
  // 之前误读了 Via Protocol26_2To26_3:181-189 的 appendClientbound：wrapper.write 写进
  // 新 output 头部、原条目透传在后 → brewing_input/brewing_reagent 只是 recipes 数组的
  // 头两个普通元素（string + varint[]），26.1 的数组结构原样可用，不需要额外字段。
  // 服务器实测：按尾部独立字段解析会在读 brewing 条目的 string 长度时 buffer 尽炸。

  // 26.3：SlotDisplay 的 tag 分支 STRING → HolderSet
  // （Via RecipeDisplayRewriter26_3.handleTag → handleIngredient，即 Types.HOLDER_SET；
  //  线上格式 = varint 前缀 0 → string，>0 → N 个 varint，与 native registryEntryHolderSet 一致）
  const slotDisplay = play.SlotDisplay
  const dataSwitch = slotDisplay?.[1]?.find(f => f.name === 'data')?.type?.[1]
  if (dataSwitch?.fields?.tag === 'string') {
    dataSwitch.fields.tag = ['registryEntryHolderSet', {
      base: { name: 'name', type: 'string' },
      otherwise: { name: 'ids', type: 'varint' }
    }]
  }

  // 26.3：serverbound spectator_action（原 spectate_entity）target = 单 varint：
  // 0=取消 spectating，否则 entityId+1（OPTIONAL_VAR_INT 语义，不是 option 前置 bool）。
  // bot 若使用 spectate 需自行做 +1 映射（目前代码没用）。
  const spectate = playServer.packet_spectator_action
  if (spectate && Array.isArray(spectate[1])) {
    const spectateTarget = spectate[1].find(f => f.name === 'target')
    if (spectateTarget) spectateTarget.type = 'varint'
  }

  // 26.3：serverbound update_sign = [pos, 4×string, slot varint]（isFrontText bool 移除、尾部变 slot）。
  // mineflayer 写 update_sign 仍用 isFrontText 字段——bot 写告示牌时需带 slot（0=背 1=面）。
  playServer.packet_update_sign = ['container', [
    { name: 'location', type: 'position' },
    { name: 'text1', type: 'string' },
    { name: 'text2', type: 'string' },
    { name: 'text3', type: 'string' },
    { name: 'text4', type: 'string' },
    { name: 'slot', type: 'varint' }
  ]]

  // 26.3：advancements 的 xCord/yCord 从 displayData 内部移到每个条目的末尾
  //（26.3 PositionedAdvancement = [AdvancementHolder, x f32, y f32]；Via handler 明确做了搬移）
  const advMapping = play.packet_advancements?.[1]?.find(f => f.name === 'advancementMapping')
  const advEntry = advMapping?.type?.[1]?.type?.[1]?.find(f => f.name === 'value')?.type?.[1]
  if (advEntry) {
    const displayWrap = advEntry.find(f => f.name === 'displayData')
    const displayFields = displayWrap?.type?.[1]?.[1]
    if (displayFields) {
      const xs = displayFields.find(f => f.name === 'xCord')
      const ys = displayFields.find(f => f.name === 'yCord')
      if (xs && ys) {
        displayFields.splice(displayFields.indexOf(xs), 1)
        displayFields.splice(displayFields.indexOf(ys), 1)
        advEntry.push({ name: 'xCord', type: 'f32' }, { name: 'yCord', type: 'f32' })
      }
    }
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

// 新包名 → packet_<name> 类型：写进 packet 容器的 params switch fields。
// 只改 name mapper 不够 —— protodef 的 packet = [name mapper, params switch]，
// fields 缺条目时 params 类型为 undefined → 编译后静默不读 payload（实测 post_effects 只吞 id）。
function addPacketFields (types, names) {
  const fields = types.packet[1][1].type[1].fields
  for (const name of names) fields[name] = 'packet_' + name
}

function patchProtocol (protocol, components263) {
  // 1) 包 id 表移位（已与 Via ClientboundPackets26_3 / ServerboundPackets26_3 枚举逐 id 对齐验证）
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
  // 新包名补进 params switch fields（缺了会静默丢 payload）
  addPacketFields(pc, ['add_transient_block', 'post_effects', 'swing_animation'])
  addPacketFields(ps, ['punch', 'spectator_action'])
  addPacketFields(cc, ['post_effects'])
  // add_transient_block 真实结构 = [pos blockposition, blockstate varint]
  //（ClientboundAddTransientBlockPacket；旧补丁 ViaSkip 只是不丢帧、丢数据）
  pc.packet_add_transient_block = ['container', [
    { name: 'location', type: 'position' },
    { name: 'stateId', type: 'varint' }
  ]]
  // post_effects = varint 数量 + N 个 identifier 字符串（vanilla ClientboundPostEffectsPacket）
  pc.packet_post_effects = ['array', { countType: 'varint', type: 'string' }]
  cc.packet_post_effects = ['array', { countType: 'varint', type: 'string' }]
  // spectate_entity 改名（26.3 SPECTATOR_ACTION，结构见 patchFieldTypes）
  ps.packet_spectator_action = ps.packet_spectate_entity
  delete ps.packet_spectate_entity
  // mapper 里的包名也要同步（protodef 按 mapper 值找 packet_<name> 类型）
  const psMapper = ps.packet[1][0].type[1].mappings
  for (const [id, name] of Object.entries(psMapper)) {
    if (name === 'spectate_entity') psMapper[id] = 'spectator_action'
  }
  // spectate_entity 改名后的 fields 引用也同步（否则 spectate 包解析为空）
  const psFields = ps.packet[1][1].type[1].fields
  if (psFields.spectate_entity) {
    delete psFields.spectate_entity
    psFields.spectator_action = 'packet_spectator_action'
  }

  // 2) 字段手术 + 新包类型
  patchFieldTypes(protocol)

  // 3) 组件表 + 结构
  patchSlotComponentTypes(protocol, components263)

  return protocol
}

module.exports = { patchProtocol }
