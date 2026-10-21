# 取货交付与无位置记录处置方案

## 1. 背景与目标

取货交付链路是：从木桶取出 → `/tpa` 传送到玩家 → 丢出物品。当前传送后到开始丢物品之间存在一段**固定盲目等待**，且瞄准点取在玩家身体上方 1.4 格（实测约胸部/头部高度）。

另有一条取货失败分支需要改：账本有库存、但**找不到木桶位置记录**时，当前做法是"跳过重试 + 玩家残余物品入库 + 让管理员 `!同步` 对账"。这条路径放弃得太早——仓库里其他木桶可能确实有货，只是这个物品没有槽位记录。

本次要解决三个问题：

1. **丢前瞄准点改为玩家脚部**——即玩家身体底部中心（`entity.position` 本身，脚底坐标）。
2. **传送后不再盲等**——改为"等到 `bot` 自己和目标玩家所在区块都已加载"就立刻瞄准开始丢，不再等区块全量加载。
3. **无位置记录时改为现场搜桶**——用目标木桶的实测信息刷新库存记录，不把残余物品入库，并继续尝试下一个木桶。

## 2. 现状分析

### 2.1 传送后等待（`src/service.js`）

`teleportToPlayer()`（约 3483 行）：

```js
const ok = await this.waitForPlayerNearby(username, timeoutMs, radius, options)
if (ok) {
  await sleep(this.config.timing.postTeleportWaitMs || 500)
  return true
}
```

- 距离判定：`waitForPlayerNearby` 每 250ms 轮询一次，玩家实体与 bot 距离 `<= teleportDetectRadius`（默认 8）即认为传送成功。
- 之后**无条件 `sleep(postTeleportWaitMs)`**，`DEFAULT_CONFIG` 里是 1500，`config.example.json` 也是 1500。
- **当前没有任何区块加载判定**。注释和 README 也没有提到"等区块"这件事，实际行为就是"盲等 1.5 秒"。

### 2.2 丢前瞄准（`src/warehouse.js`）

```js
async lookAtPlayer (username, yOffset = 1.4) {
  const entity = this.bot.players[username]?.entity
  if (!entity) {
    this.debug(`cannot look at player ${username}: entity not found`)
    return
  }
  const target = entity.position.offset(0, yOffset, 0)
  await this.bot.lookAt(target, true)
  await sleep(100)
}
```

- 默认 `yOffset = 1.4`，即**脚底往上 1.4 格**，落点在身高 1.8 玩家的胸口偏上。
- 调用点四处：
  - `dropItemsToPlayer()` 每轮开始前（`warehouse.js` 2773）——主交付路径
  - `dropInventoryToPlayer()`（2738）
  - `repairPlayerWithExperienceBottles()`（2857，显式传 `0.35`，修装备用）
  - `service.js` 1603 `dropWithdrawItemsToPlayer` 的兼容分支（1627）
- **实体缺失时静默返回**：不抛错、不重试，后续 `clickWindow(mode 4)` 仍会按**上一次视线**丢出物品。传送后区块未到位、玩家实体还没解析出来的情况下，这是实实在在的"丢歪"风险。

### 2.3 无位置记录分支的现状（`src/warehouse.js` + `src/service.js`）

`withdrawAllocationsLocked()` 里，账本有量但 `listSlotsForItemKey()` 返回空：

```js
if (!chestGroups.length) {
  this.reportMissingLooseRecord(allocation, itemInfo)
  unlocated.push({ ...itemInfo, amount: allocation.amount })
}
```

注意这里**只是登记异常并标记 `unlocated`，并不 `continue`**，但因为没有 `chestGroups`，后面的 `for (const group of chestGroups)` 循环体一次都不执行，于是 `remaining` 保持原值，最终：

```js
if (remaining > 0) {
  missing.push({ ...itemInfo, amount: remaining })
}
```

也就是说：**一个木桶都没打开**，就直接计入缺失。

上层 `runWithdrawFlow()` 收到"一批都没取到 + 缺失项全都 `unlocated`"后走 `failed_no_location`：

1. `goHome({ requireWarehouse: true })`
2. `depositInventoryWithoutBalance('withdraw_failed_return')` —— **残余物品入库**
3. 私聊报"账本有库存，但仓库木桶里找不到实物位置……请管理员执行 `!同步` 对账"
4. `clearRecoveryTask`，返回 `failed_no_location`

对应测试：`test/withdraw-shortage-retry.test.js` 的 `fully unlocated missing skips the pointless recheck retry and asks for a sync`，断言"只取一轮、不重试、残余入库一次、提示 `!同步`、不扣账"。

问题在于：`chests` 表里登记的**其他木桶**可能真有这个物品，只是这个 owner 的槽位记录丢了。直接判死 + 让残余入库，等于放弃了一次几乎不需要代价的现场排查。

### 2.4 为什么现在要改

- 传送落地瞬间，bot 所在区块和玩家所在区块由服务端分批下发（1.21.8 是 `chunk_batch_start` / `chunk_batch_received` 批量包）。固定 1.5 秒在正常网络下够用，但网络抖动或跨维度传送时会不够，正是"实体没解析出来还静默丢"的窗口。
- 反过来，卡顿恢复后 1.5 秒又往往是多余的，白白拖慢每一批交付（多批时按批累计）。
- 瞄准点偏高 1.4 格，在平地上影响不大，但玩家站台阶、半砖、矿车、船等矮位时，高瞄点会让丢出方向偏上，物品落点偏移。

## 3. 方案设计

### 3.1 瞄准点改为脚部（P0，改动小、风险低）

**核心改动**：`lookAtPlayer` 的默认 `yOffset` 从 `1.4` 改为 `0`。

```js
// 丢前瞄准：对准玩家身体底部中心（脚底坐标），避免高瞄点让丢出方向偏上。
async lookAtPlayer (username, yOffset = 0) {
  ...
  const target = entity.position.offset(0, yOffset, 0)
  ...
}
```

注意点：

- `repairPlayerWithExperienceBottles` **显式传了 `0.35`**，是参数化调用，不受默认值变更影响。修装备是"右键使用经验瓶"，作用目标和丢物品不同，**保持原样不动**。
- 脚底坐标 `entity.position` 是脚部方块中心（`y` 为脚底高度）。`lookAt` 用 `force = true` 会强制转身，落点在脚底中心，平地玩家需向下俯视。
- 已有 100ms 的 `sleep` 让转身包落地，保留。

**验证**：`test/withdraw-batch-confirm.test.js` 里的 `createDropBot()` 造的 `bot` 没有 `lookAt`，且 `players` 为空。当前逻辑走 `if (!entity) return` 分支，因此现有 4 个丢物品用例**不受影响**。

### 3.2 传送后等"两侧区块就绪"代替固定 sleep（P0）

新增一个就绪判定，替代 `sleep(postTeleportWaitMs)`。

**判定条件**（全部满足即就绪）：

1. `bot.entity.position` 存在（传送后的服务端位置包已应用）。
2. **bot 所在区块已加载**：`bot.world.getColumnAt(bot.entity.position)` 非空。
3. **目标玩家实体存在**且 `players[username].entity.position` 有效。
4. **目标玩家所在区块已加载**：`bot.world.getColumnAt(target.position)` 非空。

满足上述条件后立即 `lookAtPlayer` 瞄准并返回，不再额外 sleep。

**实现位置**：`src/service.js` 的 `teleportToPlayer()`，把

```js
if (ok) {
  await sleep(this.config.timing.postTeleportWaitMs || 500)
  return true
}
```

改为

```js
if (ok) {
  await this.waitForTeleportChunksReady(username, { timeoutMs, options })
  return true
}
```

并新增方法 `waitForTeleportChunksReady`：

```js
// 传送后不等区块全量加载：只要 bot 自己和目标玩家所在区块都已就绪，
// 就让调用方立即瞄准丢物。轮询间隔与 waitForPlayerNearby 一致（250ms）。
async waitForTeleportChunksReady (username, options = {}) {
  const timeoutMs = Number(options.timeoutMs) || this.config.timing.postTeleportWaitMs || 500
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (!options.ignoreCancellation && this.isActiveCancelled()) return false
    const botPos = this.bot.entity?.position
    const entity = this.bot.players[username]?.entity
    const targetPos = entity?.position
    const botChunkReady = Boolean(botPos && this.bot.world?.getColumnAt?.(botPos))
    const targetChunkReady = Boolean(targetPos && this.bot.world?.getColumnAt?.(targetPos))
    if (botChunkReady && targetChunkReady) return true
    await sleep(250)
  }
  return false
}
```

**超时语义**：`postTeleportWaitMs` 的含义由"固定等待时长"变成"**等待区块就绪的上限**"。超时后**不中断交付**——因为距离判定已经通过（玩家在 8 格内），继续丢物是可接受的，只是保留原有的"最坏情况 1.5 秒"兜底。这样对现有配置完全向后兼容，不需要迁移。

> 备选：如果希望超时后完全不丢，可以把超时当成失败返回 `false`，让 `runWithdrawBatches` 走现有的"传送超时回仓入库"分支（`withdraw_tpa_timeout`）。但该分支已有自己的语义（玩家没接受传送），复用会混淆日志和玩家提示，**不推荐**。

**为什么不用 `sleep(0)` 直接跳过**：那等于完全不等，最坏情况下 `entity` 还没解析出来，`lookAtPlayer` 走缺失分支静默返回，反而放大 3.3 要解决的问题。

### 3.3 瞄准失败不再静默（P1，配套加固）

`lookAtPlayer` 在实体缺失时目前只打 debug 日志就返回，调用方无从得知，直接按旧视线丢物。

改为：**实体缺失时抛出明确错误**，由上层按既有失败路径处理（`runWithdrawBatches` 的 `dropWithdrawItemsToPlayer` 抛错 → `handleWithdraw` 的 catch → `handleCommandError` 提示玩家，同时 `saveRecoveryTask` 已记录 `withdraw_dropping` 阶段，背包物品由后续回仓逻辑收回）。

```js
if (!entity) {
  throw new Error(`丢前瞄准失败：找不到玩家 ${username} 的实体（区块可能尚未加载）`)
}
```

风险控制：`dropInventoryToPlayer` / `dropWithdrawItemsToPlayer` 都有"背包数量差"最终对账，抛错不会造成误扣账。3.2 的就绪等待已经把"实体不存在"压缩到超时兜底这一种情况，这里只是把残余概率变成显式失败，而不是静默按旧方向丢。

> 若担心抛错导致任务整体失败过于激进，可退一步：**返回布尔值**，`dropItemsToPlayer` 在瞄准失败时**跳过本轮**而不是继续按旧视线丢。但这样会掩盖问题，建议先用抛错版。

### 3.4 无位置记录：现场搜桶 + 用实测信息刷新记录（P0）

把"无槽位记录就直接判死"改成"**打开木桶找货，用实测内容覆盖记录**"。

#### 3.4.1 木桶候选清单

改 `withdrawAllocationsLocked()`：

```js
if (!chestGroups.length) {
  // 账本有量但没有任何槽位位置记录：不直接判死，改为打开已登记的木桶现场找货。
  // 查到就用实测内容刷新该桶记录，并继续下一个木桶，直到凑够或搜完。
  this.trace('plan', 'unlocated_search_start', { ... })
  unlocated.push({ ...itemInfo, amount: allocation.amount })
  chestGroups = this.buildUnlocatedSearchGroups()
}
```

新增 `buildUnlocatedSearchGroups()`：

- 数据源：`this.db.listChests()`（`chests` 表里所有已登记木桶，含坐标为 0 的）。
- 排序：按**距离 bot `/home` 后位置**由近到远（`homePosition`，没有则用当前 `entity.position`）。近的先搜，凑够就停。
- 每项：`{ chestId, recordedAmount: 0, slots: [{ x, y, z, blockName }], unknown: true }`。`recordedAmount: 0` 表示"账本没记录，未知"。

#### 3.4.2 搜索时的数量上限

搜桶是"碰运气"，必须有界，否则一次取货会把整个仓库的木桶全开一遍：

- 新配置项 `timing.withdrawMaxUnlocatedBarrels`，默认 `12`。
- 与现有 `withdrawMaxMissingBarrels`（缺货换桶上限 5）相互独立：搜桶没找到**不计**缺货跳桶；缺货跳桶也不消耗搜桶额度。

#### 3.4.3 打开木桶：单次最多等 5 秒，收到内容立即结束

无记录搜桶**不复用** `openContainerAt` 的重试阶梯。`openContainerAt` 默认按 `openContainerTimeoutsMs = [2000, 4000, 8000]` 最多试 3 轮，**最坏 14 秒才判一个桶失败**——搜 12 个桶不能接受。

搜桶模式走独立的打开逻辑，**单次尝试、5 秒上限**：

```js
async openSearchContainer (chest) {
  const waitMs = Number(this.config.timing?.unlocatedBarrelWaitMs ?? 5000)
  const block = this.bot.blockAt(new Vec3(chest.x, chest.y, chest.z))
  if (!block || !this.chestNames.has(block.name)) return { kind: 'not_barrel' }

  const container = await this.openContainerBlock(block, waitMs)  // 只给一次超时，不重试
  if (!container) return { kind: 'no_content' }                   // 5 秒无内容：按约定认定空桶
  return { kind: 'container', container }
}
```

要点：

1. **只有一次尝试**，不套 `openContainerAt` 里的 `for (let attempt = 0; ; attempt++)` 递增重试。
2. **中途同步完毕立即结束等待**：`openContainerBlock` 内部 `bot.openContainer(...)` 在收到 `windowOpen` / 容器内容包时 promise 立刻 resolve，`withTimeout` 随之结束——不需要额外轮询、不需要等满 5 秒。
3. **5 秒内没有任何容器内容 → 判定该木桶为空**（记为 `empty_timeout`），**不抛错**，直接继续下一个桶。
4. `withTimeout` 超时只是让上层提前放弃等待，**底层 `openContainer` 的 promise 仍可能在之后 resolve**。实现时必须：
   - 超时分支立即 `closeLingeringWindow()`，避免迟到的窗口挂成 `bot.currentWindow` 干扰下一个桶；
   - 超时后不再复用该 promise，下一桶重新发起。
5. 这个 5 秒是**单桶上限**，不是整轮上限；12 个桶最坏 60 秒，仍远优于旧路径的单桶 14 秒。

#### 3.4.4 服务器不会主动告知"空桶"，四种观察结果必须分开

**协议事实**（1.21.8，`minecraft-data` 核对）：

| 包 | ID | 字段 |
|---|---|---|
| `open_window` | 0x2F | `windowId`、`inventoryType`、`windowTitle` —— **不含内容** |
| `window_items` | 0x12 | `windowId`、`stateId`、`items[]`、`carriedItem` —— 完整内容 |
| `close_window` | 0x11 | 只有 `windowId` |

协议里**没有**"这个桶是空的"这种语义。空桶只是一个 `window_items`，其中 `items` 全是空 `Slot`（`count = 0`）。所以"空"只能由客户端从"收到了窗口但内容为空"这一形态推断，服务器不会单独通知。

客户端实际可能观察到的四种结果，处理必须区分：

| 观察到的情况 | 含义 | 搜桶处理 | 计数标记 |
|---|---|---|---|
| 收到 `window_items`，`items` 全空 | **真真空桶** | 保留原记录跳过，不做空读重读 | `empty_window` |
| 收到 `window_items`，有内容 | 正常桶 | 按 3.4.5 取物 / 刷新记录 | `ok` |
| **只收到 `close_window`，没有 `window_items`** | 服务器拒绝了这次开箱（反作弊、距离、权限等），**与桶里实际有多少东西无关** | 跳过继续，**绝不能当成空桶** | `refused` |
| 5 秒内既无 `window_items` 也无 `close_window` | 消息丢失 / 服务器无响应 | 按约定认定空桶并继续 | `no_content` |
| 走到坐标发现不是木桶 | 桶被拆/换 | 跳过继续 | `not_barrel` |

**重点**：第 3 行是容易写错的地方。`close_window` 只说明"这次没打开"，不能据此刷新库存记录，也不能计入"空桶"统计——否则会把一个本来有货的桶误标为空，后续 `!同步` 对账时出现假的缺口。

实现上，`openContainerBlock` 当前把"空窗口"（`container` 为 falsy）和"超时"都归到 `allOpenTimeouts`。搜桶需要额外拿到**是哪种情况**，因此：

- 在 `openSearchContainer` 内单独监听 `bot._client.once('close_window')`，用标志位区分；
- 或让 `openContainerBlock` 对失败原因打标（`error.openResult = 'refused' | 'timeout'`），搜桶据此分流。

推荐后者，避免在搜桶逻辑里重复挂事件、也便于测试桩模拟。

#### 3.4.5 打开木桶后的处理

差异对照：

| 情况 | 现有（有记录）行为 | 新增（无记录搜索）行为 |
|---|---|---|
| 桶内**有目标物品** | 按 `min(remaining, available)` 取 | 同样取，且**用实测内容刷新该桶记录** |
| 桶内**没有目标物品但有别的东西** | 刷新记录（`refreshChestSnapshot`） | **同样刷新记录**，然后继续下一个桶 |
| 桶**完全读空**（已拿到窗口但内容为空） | 关窗重开重读，仍空 → 保留原记录跳过 | **保留原记录跳过**，不做空读重读（省时间），继续下一个 |
| **只收到 `close_window`**（被拒绝开箱） | 走递增重试 | **跳过继续，不写记录、不计空桶** |
| **5 秒内没有任何容器内容** | 走递增重试 | **按约定认定空桶**，不抛错、不写记录，继续下一个 |
| 走到坐标发现不是木桶 | 抛错 | **不抛错**，跳过该坐标，继续下一个 |

关键点：**只要桶读到了可信内容（`totalInChest > 0`），就用实测内容调用 `refreshChestSnapshot(chest, container)` 覆盖本地槽位记录**——这正是"用目标木桶的信息更新库存"。账本（`balances`）不动，只更新 `chest_slots` / `chests` 快照。

刷新记录与取物的顺序：**先取再刷新**，与现有有记录路径一致（`tryWithdrawExactFrom` 之后再 `refreshChestSnapshot`），保证写入快照的是取完后的真实剩余量；若该桶没有目标物品，则直接刷新，把账本外的实际内容落到记录里。

#### 3.4.5 搜到后是否立刻取

搜到就直接取，不和"是否属于该 owner"纠缠。理由：`chest_slots` 记录本身不带 owner，现有 `refreshChestSnapshot` 也是不分归属地按窗口内容刷新。搜到货并取出后，`recordWithdrawDeduction` 照常按 `ownerUuid` 扣账，账实之间由既有 `momo` 机制兜底。

#### 3.4.6 "不把残余物品入库"

`runWithdrawFlow()` 的 `failed_no_location` 分支里移除这次入库：

```js
await this.warehouse.goHome({ requireWarehouse: true })
const returned = await this.warehouse.depositInventoryWithoutBalance('withdraw_failed_return', ...)
if (returned.leftover.length) { msgActor(...) }
msgActor(`账本有库存，但仓库木桶里找不到实物位置...`)
```

改为：

- **不再调用 `depositInventoryWithoutBalance`**。
- 残余物品留在机器人背包，交给现有的 `withdraw_return_home` 阶段 / 任务结束时统一回仓（`runWithdrawBatches` 每批结束后的 `withdraw_residual_return`）。
- 但要注意：`failed_no_location` 是"一个都没取到"才会走到，此时背包里通常是**取货过程中残留的杂物**，而非本次取货目标。若不入库，这些杂物会跟着机器人进下一个任务——现有 `settleResidualToMomo()` / `flushResidual()` 已在任务开头处理这一类残留，因此留背包是安全的。

> 如果希望更稳妥，可只跳过"本次取货目标物品"的入库、其余照常入库。但那需要按 `itemKey` 拆分 `depositInventoryWithoutBalance` 的返回值，改动面变大，**建议先按"完全不入库"实现**，观察一个版本。

#### 3.4.7 搜完仍没找到

搜桶额度用尽或所有木桶搜完仍没有：

- 保留 `unlocated` 标记与 `reportMissingLooseRecord` 的库存异常登记（Web 管理页可见）。
- 仍返回 `failed_no_location`，私聊文案调整为：`账本有库存，但已逐个打开 N 个木桶仍找不到实物……已登记库存异常，请管理员执行 !同步 对账后再试。`
- 仍然**不扣账**。

#### 3.4.8 链路日志

新增 trace 事件，便于排查：

| phase | event | 关键字段 |
|---|---|---|
| `plan` | `unlocated_search_start` | `candidates`（候选桶数）、`limit` |
| `locate` | `unlocated_search_chest` | `chest`、`index/total`、`actual`（该桶实测目标数） |
| `open` | `unlocated_search_open_timeout` | `chest`、`waitedMs`、`decision: '5秒内没有容器内容，按约定认定空桶'` |
| `open` | `unlocated_search_open_refused` | `chest`、`decision: '只收到 close_window，服务器拒绝开箱，不计空桶、不写记录'` |
| `record` | `unlocated_search_refresh` | `chest`、`contents`（实测快照） |
| `take` | `unlocated_search_take` | `chest`、`moved`、`remaining` |
| `decision` | `unlocated_search_exhausted` | `searched`、`emptyCount`、`refusedCount`、`timeoutCount`、`remaining` |

## 4. 改动清单

| 文件 | 位置 | 改动 |
|---|---|---|
| `src/warehouse.js` | `lookAtPlayer`（约 2918 行） | `yOffset` 默认 `1.4` → `0`；实体缺失由静默返回改为抛错 |
| `src/service.js` | `teleportToPlayer`（约 3493 行） | `sleep(postTeleportWaitMs)` 替换为 `waitForTeleportChunksReady(...)` |
| `src/service.js` | 紧邻 `waitForPlayerNearby` 之后 | 新增 `waitForTeleportChunksReady` 方法 |
| `src/warehouse.js` | `withdrawAllocationsLocked` 无 `chestGroups` 分支（约 564 行） | 改为调用 `buildUnlocatedSearchGroups()` 现场搜桶，不再直接计入缺失 |
| `src/warehouse.js` | 紧邻 `groupSlotsForWithdrawal` 之后 | 新增 `buildUnlocatedSearchGroups()`；新增 `openSearchContainer()`（单次、5 秒上限）；新增无记录搜索模式的桶循环（或给现有循环加 `unknown` 分支） |
| `src/warehouse.js` | 搜桶打开调用处 | 搜桶走 `openSearchContainer`，**不复用** `openContainerAt` 的 2/4/8 秒递增重试；区分 `empty_window` / `refused` / `no_content` / `not_barrel` 四种结果 |
| `src/warehouse.js` | `openContainerBlock` 失败分支（约 2416 行） | 失败原因打标：`error.openResult = 'refused' \| 'timeout'`，供搜桶分流 |
| `src/service.js` | `runWithdrawFlow` 的 `failed_no_location` 分支（约 1365-1378 行） | 移除 `depositInventoryWithoutBalance('withdraw_failed_return')`；调整提示文案为"已搜 N 个桶" |
| `src/config.js` | `timing` 段（约 57 行 `withdrawMaxMissingBarrels` 附近） | 新增 `withdrawMaxUnlocatedBarrels: 12`、`unlocatedBarrelWaitMs: 5000`；`postTeleportWaitMs` 加语义注释 |
| `config.example.json` | 对应两处 | 同步新增配置与注释 |
| `docs/teleport-aim-optimization-plan.md` | 本文件 | 方案 |

不改动：`repairPlayerWithExperienceBottles` 的 `lookAtPlayer(username, 0.35)` 保持原值。

## 5. 配置语义变化说明

### 5.1 `timing.postTeleportWaitMs`

- 旧：传送检测成功后**固定等待**这么久再开始丢物。
- 新：传送检测成功后**最多等待**这么久，等 bot 与目标玩家两侧区块就绪；就绪则立即开始，超时仍继续。

默认值 1500 保持不变，老配置不需要迁移，行为在正常网络下从"固定 1500ms"变为"通常 0~500ms"。

### 5.2 `timing.withdrawMaxUnlocatedBarrels`（新增）

- 含义：账本有库存但无槽位位置记录时，最多打开多少个已登记木桶现场找货。
- 默认 `12`。设为 `0` 等价于回到旧行为（不搜桶，直接 `failed_no_location`）。
- 与 `withdrawMaxMissingBarrels` 独立计数。

### 5.3 `timing.unlocatedBarrelWaitMs`（新增）

- 含义：搜桶时**单个木桶**等待服务器下发容器内容的上限。
- 默认 `5000`。窗口在等待期间到达就立即结束等待，继续下一步（取物或刷新记录）。
- 整段超时没有任何容器消息 → 认定该桶为空，跳过并继续下一个桶，不抛错、不写空记录。
- 与 `openContainerTimeoutsMs`（`[2000, 4000, 8000]`，正常取货路径的递增重试）互不影响。

## 6. 测试

### 6.1 传送与瞄准

新增 `test/teleport-chunk-ready.test.js`：

1. **两侧区块就绪即返回**：mock `bot.world.getColumnAt` 返回非空、`players[username].entity.position` 有效 → `waitForTeleportChunksReady` 在首个轮询就返回 `true`，耗时远小于 `postTeleportWaitMs`。
2. **bot 区块未就绪则继续等**：`getColumnAt(botPos)` 返回 `null`，其余就绪 → 等到超时返回 `false`。
3. **玩家区块未就绪则继续等**：`getColumnAt(targetPos)` 返回 `null` → 超时返回 `false`。
4. **玩家实体缺失则继续等**：`players[username]` 为空 → 超时返回 `false`。
5. **任务取消立即退出**：`isActiveCancelled()` 为 `true` → 立即返回 `false`。

扩展 `test/withdraw-batch-confirm.test.js`：

6. **瞄准点在脚部**：给 `createDropBot()` 补 `lookAt` 与 `players.Player.entity`，断言 `lookAt` 收到的坐标为 `entity.position`（即 offset 0），与旧 1.4 版本对比。
7. **实体缺失时抛错**：`players.Player` 为空 → `dropItemsToPlayer` reject，且 `clickWindow` 未被调用（确保没有按旧视线丢物）。

### 6.2 无位置记录搜桶

新增 `test/withdraw-unlocated-search.test.js`（基于 `withdraw-batch-confirm.test.js` 的假 bot/db 风格）：

1. **无记录时打开木桶找货并取出**：`listSlotsForItemKey` 返回空、`listChests` 返回 2 个桶，第 1 个桶内有目标物品 → 取出成功、`replaceChestSlots` 被调用、返回 `withdrawn` 非空、`unlocated` 仍有标记。
2. **用实测内容刷新记录**：桶内没有目标物品但有其他物品 → `replaceChestSlots` 写入的是该桶实测内容，且继续打开下一个桶。
3. **读到空桶不写空记录**：能拿到窗口但内容为空 → 不调用 `replaceChestSlots`，保留原记录，继续下一个桶。
4. **5 秒无内容视为真空桶**：`openContainer` 永不 resolve → `unlocatedBarrelWaitMs` 到点后跳过该桶（`timeoutCount` +1），**不抛错**、不写记录，继续下一个桶。
5. **窗口提前到达立即结束等待**：`openContainer` 在 200ms 后 resolve → 整轮耗时接近 200ms 而非 5000ms，并立即进入取物/刷新。
6. **超时后关窗**：超时分支会调用 `closeLingeringWindow`，避免迟到的窗口干扰下一个桶。
7. **只收到 `close_window` 判为 refused**：不写记录、不计入 `emptyCount`、继续下一个桶；与 `no_content` 分开统计。
8. **真真空桶（`window_items` 全空）判为 `empty_window`**：保留原记录跳过，不计入 `refused`。
9. **搜桶上限生效**：`withdrawMaxUnlocatedBarrels = 2`、`listChests` 返回 5 个桶 → 最多只打开 2 个，后续走 `failed_no_location`。
10. **非木桶坐标跳过不抛错**：某坐标 `blockAt` 返回普通方块 → 跳过，继续下一个。
11. **`withdrawMaxUnlocatedBarrels = 0` 时保持旧行为**：不打开任何桶，直接计入缺失。

修改 `test/withdraw-shortage-retry.test.js`：

12. **`fully unlocated missing skips the pointless recheck retry and asks for a sync`** 需更新：现在会先搜桶（测试桩里 `listChests` 返回空即可维持"搜不到"），断言从"残余入库一次"改为"**残余不入库**（`depositCalls` 中无 `withdraw_failed_return`）"，提示文案包含搜桶数量。

回归：`npm test` 全量通过；`npm run check` 语法检查通过。

## 7. 风险与边界

| 风险 | 说明 | 处置 |
|---|---|---|
| 服务端不按 `chunk_batch_received` 常态下发 | 某些代理/子服可能一次推大片区块，`getColumnAt` 很快非空，等待退化为几乎 0 | 可接受，正是期望效果 |
| 玩家实体依赖 `player_info` / `add_player` 包 | 玩家在视野外时实体可能延迟出现，靠超时兜底 | 已有 8 格距离判定 + `postTeleportWaitMs` 兜底 |
| `bot.world` 或 `getColumnAt` 不存在（旧 mineflayer / 测试桩） | 直接调用会抛 TypeError | 用可选链 `this.bot.world?.getColumnAt?.(pos)`，返回 falsy 视作未就绪 |
| 瞄准点降到脚底后物品落点变化 | 平地丢物方向由"略向上"变为"水平略向下"，物品落在玩家脚边 | 符合需求；`repairPlayerWithExperienceBottles` 不受影响 |
| 抛错导致任务失败 | 3.3 会把原本静默丢歪的情况变成显式失败 | 背包有"数量差"对账，不产生误扣账 |
| **搜桶把整个仓库开一遍** | 木桶多时耗时极长 | `withdrawMaxUnlocatedBarrels` 默认 12 封顶；按距离由近到远；单桶 5 秒上限 |
| **5 秒超时后服务器迟到下发窗口** | `withTimeout` 只放弃上层等待，底层 `openContainer` 仍可能 resolve，迟到的窗口会挂成 `currentWindow` | 超时分支立即 `closeLingeringWindow()`，下一桶重新发起 |
| **把 `close_window` 误判成空桶** | 服务器拒绝开箱时只发 `close_window`，桶里可能仍有货；误判会让记录失真，`!同步` 时出现假缺口 | 单独标记 `refused`，跳过但**不写记录、不计空桶**；与 `no_content` 分开统计 |
| **慢服务器下 5 秒不够** | 服务器卡顿时容器内容可能确实超过 5 秒才到，被误判为空桶 | 可通过 `unlocatedBarrelWaitMs` 调大；误判只影响搜桶这一轮，不影响正常取货路径 |
| **搜桶期间写入实测记录与并发同步冲突** | 已有 `withWarehouseLock` 串行，`noteChestMutation` 会递增 revision | 复用现有锁，无需额外处理 |
| **残余不入库导致杂物跟着机器人** | 下一个任务开头 `flushResidual()` / `settleResidualToMomo()` 会处理 | 已有机制覆盖，无新增泄漏 |
| **搜到的货可能属于其他 owner** | `chest_slots` 本身不带归属 | 与 `refreshChestSnapshot` 现有语义一致；扣账仍按请求 owner |

## 8. 提交方式

- 仓库：`https://github.com/Damomo11/cloud-store`
- 提交账号：`2147983380@qq.com` 对应的 GitHub 账号
- 分支：从 `main` 切 `feat/teleport-aim-unlocated-search`
- 提交信息建议：

```
传送后瞄准改为脚部并按两侧区块就绪即丢；无木桶位置记录时改为现场搜桶

1) lookAtPlayer 默认 yOffset 1.4→0，实体缺失改为显式失败不再静默按旧视线丢物；
2) teleportToPlayer 用 waitForTeleportChunksReady 替代 postTeleportWaitMs 固定 sleep，
   仅等待 bot 与目标玩家所在区块加载完成即开始丢物，配置语义由固定等待改为等待上限（默认值不变）；
3) 账本有库存但无槽位记录时不再直接判死：按距离由近到远打开已登记木桶现场找货，
   读到可信内容即用实测内容刷新该桶槽位记录（不动账本），不把残余物品入库，
   继续尝试下一个木桶；搜桶单桶最多等 5 秒（unlocatedBarrelWaitMs，内容先到即结束等待，
   5 秒无任何容器内容按约定认定空桶继续下一个）；
   按协议区分 empty_window / refused(只收到 close_window) / no_content / not_barrel 四种结果，
   refused 不写记录、不计空桶；新增 withdrawMaxUnlocatedBarrels 上限（默认 12，0 回到旧行为）；
   搜完仍无则保留库存异常登记并返回 failed_no_location，仍不扣账。
```

- 建议先在该分支提交 PR，不改动 `main`。
