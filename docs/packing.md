# 仓库自动装盒

`src/packing/planner.js` 提供独立的纯规划器，将选定 owner 的精确散装物品分配到该 owner 已有的空潜影盒。规划器只计算数据，不读取数据库、不预留或扣除余额，也不操作机器人、背包或容器。内部控制器、持久化账务、服务端确认执行与生命周期恢复已实现；仅提供内部后端调用，没有聊天命令、HTTP 路由、GUI 按钮或玩家调度入口。

## 规划接口

```js
const { planPacking, packingStackSize, MAX_PACKING_BOXES } = require('./src/packing/planner')

const plan = planPacking({
  ownerUuid,
  items: [{ itemKey, amount }],
  availableItems,
  emptyBoxes,
  catalog,
  boxItemKey // 可选：只使用这一精确空盒指纹
})
```

`ownerUuid` 是非空且不带首尾空白的仓库归属标识，也可以是组织仓库的标识。`items` 是非空请求数组；每项必须提供已知的精确 `itemKey` 和正安全整数 `amount`。同一指纹的重复请求按首次出现顺序合并；不同名称、NBT 或组件产生的不同指纹各自占用槽位。请求携带的显示名和元数据不作为物品来源。

`availableItems` 必须是调用方在所选 owner 范围内、扣除现有预留后取得的完整可用库存快照，包含散装物品和空潜影盒。每行带有 `ItemCatalog` 的物品字段及正安全整数 `amount`；允许省略冗余的 `ownerUuid`。明确属于其他 owner 的行不会参与规划。相同指纹的库存行可合并数量，但 `itemId`、`metaJson` 和 `nbtJson` 必须一致。

`emptyBoxes` 是按选择优先级排序的候选行，每行至少包含 `itemKey` 和正安全整数 `amount`。候选必须存在于上述可用库存；它提供的 `itemId`、`metaJson`、`nbtJson` 如存在，必须与库存行一致。规划器使用库存行重新验证空盒，不相信调用方对空盒的标记。候选数量受实际可用余额约束，重复候选不会增加余额。盒子的颜色、名称和其他已存元数据沿用精确库存行。

`catalog` 为服务器版本对应的 `ItemCatalog`。全部输入保持不变，返回的物品记录与输入数据相互独立。

返回结构为：

```js
{
  ownerUuid,
  inputs,      // 聚合后的精确散装物品行，amount 为请求量
  allocations, // inputs 加上聚合空盒行；每行含 ownerUuid、itemKey、amount
  boxes: [{
    box,       // 精确空盒库存行，ownerUuid 为所选 owner，amount 固定为 1
    inputs,    // 本盒需要的精确散装物品行
    slots: [{ slot, itemKey, amount }],
    usedSlots
  }],
  boxCount,
  itemCount    // 散装物品数量之和，不计空盒
}
```

每盒的 `slot` 从 0 开始，最多 27 格。布局按首次请求指纹顺序连续填满每个堆叠，再继续下一格；每盒装满后才使用下一盒。`stone ×1728` 加 `stick ×1` 使用两盒，`stone ×64` 加 `stick ×64` 在一盒占两格。`allocations` 先列散装输入，再按实际选用顺序列空盒；空盒绝不进入散装 `inputs`。

## 容量与拒绝条件

`packingStackSize(item, catalog)` 使用目录的基础堆叠上限，例如石头 64、末影珍珠 16、钻石剑 1。存储的 `metaJson` 必须是合法 JSON 对象；`components` 可缺省、为 `null` 或组件数组。支持组件 `{ type: 'max_stack_size', data: integer }`，其中 `data` 必须为 1 至 99 的整数。当前物理转移使用基础目录容量，因此规划取 `min(基础上限, 组件上限)`，组件只能降低规划容量。所有组件类型必须有效且不能重复；带非空 `removeComponents` 的元数据暂不支持，以免误判协议相关的组件移除结果。

`nbtJson` 必须是合法 JSON 对象或 `null`。空盒的 `container` 组件如存在，必须含有 `data.contents` 数组，最多 27 项。空数组或仅包含协议空槽 `{ itemCount: 0 }` 的数组视为空盒；空槽不能带有 itemId、components 或其他字段。其余内容项均视为非空，不会因为其中物品无法识别而忽略。旧式 NBT 或组件中的 `Items` / `items` 容器列表也必须为空；不明列表结构按非空处理。这种保守校验可能拒绝自定义插件里用途不同的同名字段。

规划器抛错拒绝无效 owner、未知精确指纹、无效或溢出的数量、非法元数据、空盒伪装、库存不足、空盒不足，以及把任何潜影盒装入潜影盒的请求。所有数量及聚合运算必须保持为安全整数。单次计划最多 `MAX_PACKING_BOXES = 256` 盒，超限在展开槽位前拒绝。

## 内部执行约定

规划结果是可能过期的库存快照。内部执行层在现有仓库互斥锁内重新核验 owner 权限、可用库存和精确空盒，并原子预留 `allocations`。单盒作为持久化批次：先记录意图，取回该盒及其 `inputs`，依据服务端确认填入 27 格，核验实际内容和盒子原有元数据，再将成品归还同一仓库。余额转换必须以已确认的实际成品为依据，并保持重试幂等和原 owner 归属。

物理执行必须独立检查真实槽位容量、服务端回包、光标状态和结果内容；规划成功不构成物理操作完成或余额已转换的证据。中断恢复应保留批次证据和预留，仅在实物状态得到证明后结算或释放。执行接口保持内部使用，不注册玩家入口。

## 持久化账务接口

`src/packing/ledger.js` 导出 `PackingLedger` 类，接收真实 `StoreDb`。表在实例化账务类时创建；数据库启动查询 `hasPendingPacking(botId = '')` 不创建表。开始新计划、核验成品以及结算需要已配置的 `db.catalog`；没有目录也能读取、列出和保留待恢复记录。

```js
const ledger = new PackingLedger(db)
ledger.begin({ id, botId, owner, actor, plan })
ledger.get(id)                         // 不存在则 null
ledger.pending(botId = '')
ledger.checkpoint(id, phase, data)
ledger.settleBatch(id, batchIndex, product, packedInputs)
ledger.finish(id, status, message = '')
ledger.markRecovery(id, message, data)  // data 可省略，保留原 phase
```

`id` 以 `packing:` 开头；`owner` 为 `{ uuid, username, scope, vaultName? }`。`begin` 使用规划器的完整结果，重新核对每个精确指纹的目录身份、owner、批次布局和聚合预留。操作记录与 `reserveInventory` 处于同一 SQLite 事务；库存或预留不足时全部回滚。一个 bot 最多有一条非终态装盒记录，不同 bot 和 owner 可以各自预留。重复相同请求返回原记录；重复 ID 携带不同 owner、actor、bot 或计划时拒绝。

`get`、`pending` 和更新操作返回以下独立解析的数据；修改返回对象不会修改持久化记录。

```js
{
  id, botId, owner, actor, plan, // plan 不可由 checkpoint 修改
  state,                      // running / recovery_required / completed / failed
  phase, message, createdAt, updatedAt,
  data: { batchIndex: 0, held: [], product: null, packedInputs: [] }
}
```

`data` 可附加控制器自己的可序列化证据，例如当前批次空盒和输入、操作前/预期物品总量、源桶快照。`checkpoint` 替换整个 `data`，因此调用方应基于上一条完整数据构造新值；`batchIndex` 只能由结算推进。`held` 和 `packedInputs` 是带精确 `itemKey` 与正安全整数 `amount` 的数组。`product` 是目录格式的成品行，`amount` 必须为 1。检查点允许的 phase 为 `ready`、`withdrawing`、`withdrawn`、`packing`、`returning`、`stored`、`recovery_required`。`ready` 仅表示尚未动本批实物的初态，或上一批已安全结算；其他物理阶段不能通过普通检查点退回 `ready`。原料仍在手中时，普通检查点不能减少或清空其数量。已保存的成品/内容、取货证明和存回收据不能被清空或替换。

`markRecovery` 将 `state` 设为 `recovery_required` 并记录原因，保留原物理 `phase` 供恢复使用；如传入 data，它也必须通过原 phase 的检查点核验。该状态仍保留全部未使用预留。

## 精确木桶证据契约

账务层验证证据的结构、指纹和数量关系；控制器负责从服务端权威快照获得证据。数组中的物品总量是相应木桶或背包的完整快照，不是只过滤目标物品后的列表；每个 `chestId` 必须已登记在 `chests`。各快照可以按指纹聚合。历史全仓总量或重启后空背包本身不构成存回证明。

正常路径在实物存回前，先保存 `returning` 检查点：

```js
{
  batchIndex,
  held, product, packedInputs,
  returnIntent: {
    chests: [{ chestId, before: [{ itemKey, amount }] }],
    returned: [{ itemKey, amount }]
  }
}
```

`product` 的实际 container 组件内容必须完全等于 `packedInputs`；每项是当前计划批次的正数量子集，不能包含潜影盒。色号、名称以及移除 container 后的原空盒元数据必须保留，成品指纹必须符合目录的规范化规则。原始容器条目不能因未知类型、畸形数量或旧式隐藏内容而被忽略。部分装入后核验的盒子可以保存和结算，但整单不能成功完成。

`returned` 必须包含成品一盒和本次取出后所有未装入的散装余料。未使用下面的部分取货证明时，它按完整计划批次取出计算。允许多次 `returning` 检查点追加新目标木桶的 before 基线；已有基线、成品、内容与 returned 不得变化。新增目标木桶也必须先保存基线，再进行存入。

服务端确认返回后保存 `stored` 检查点，保留上述数据并增加：

```js
{
  // 保留 batchIndex / product / packedInputs / returnIntent / 取货证据
  held: [],
  storedProof: {
    chests: [{ chestId, after: [{ itemKey, amount }] }],
    inventoryAfter: [] // 服务端确认完整玩家物品栏为空；光标等仍由控制器核验
  }
}
```

`stored` 中的完整目标木桶集合及其 before 基线必须与此前持久化的 `returning` 意图一致；新增目标必须先单独保存 `returning` 检查点，不能在提交 after 收据时补写基线。每个目标木桶必须有唯一 after 收据；每个指纹在每个木桶的差值不能为负，所有正差合计必须恰好等于 `returned`。任何额外增加、减少、缺失木桶或非空玩家物品栏都会拒绝该检查点。无需所有成品放入同一木桶。`storedProof` 持久化后不可被普通检查点清空或修改。

## 部分取货和未转换原料的回收

取货可能在空盒或原料只取到一部分时失败。此时释放未用预留之前，必须证明哪些物品已离开源桶。在取货动作前保存 `withdrawing` 检查点及：

```js
withdrawalIntent: {
  chests: [{ chestId, before: [{ itemKey, amount }] }]
}
```

取货前一次保存本批全部已知源桶的基线；保存后整个 withdrawalIntent 不可追加、移除或修改。随后保存权威结果：

```js
withdrawalProof: {
  chests: [{ chestId, after: [{ itemKey, amount }] }],
  withdrawn: [{ itemKey, amount }],
  inventoryAfter: [{ itemKey, amount }]
}
```

证明必须引用先前已持久化的完整源桶基线。每桶每种指纹的变化只能为减少；所有减少的合计必须恰好等于 `withdrawn`，且 `withdrawn` 只能是当前批次空盒加输入的子集。`inventoryAfter` 必须恰好等于 `withdrawn`。证明一旦保存即不可替换。

若没有发生转换，令 `product=null`、`packedInputs=[]`；`returnIntent.returned` 必须恰好等于证明中的 `withdrawn`。完整批次取货也可直接返回原空盒和全部原料，不需要部分取货证明。通过上述 `returning` → `stored` 收据后可 `finish(id, 'failed')`，无需结算转换行；余额保持原样。零取货仍需源桶未变化与空背包证明，此时允许 `returnIntent.chests=[]`、`returned=[]`、`storedProof.chests=[]`。出现已验证的非空成品后，不能改为此原料回收路径。

若只取出部分原料后产生了成品，则 returned 为 proven withdrawn 减去空盒与已装输入、再加成品；源桶内没动过的部分不用假装存回。结算和失败完成仍要求完整的取货与存回证明。

## 原子结算与终态

`settleBatch` 仅接受当前持久化批次和有效 `stored` 证据。单个 SQLite 事务核验本 owner 的精确剩余预留与余额、写入规范成品、扣一只空盒和实际装入输入、加一只成品、逐项减少本操作预留，写入唯一的 `packing_batches` 行和 `packing_batch` 流水，然后将 `batchIndex` 加一并重置 data 为下一批初始结构。零数量预留直接删除，不释放其他操作预留。异常时以上所有动作一起回滚。

结算返回 `{ operationId, batchIndex, product, packedInputs, full }`。完全相同的重复结算返回原结果；改动成品或 packedInputs 的重复提交拒绝，即使操作已终态也一样。完成的转换行将完整 stored 检查点 data 保存为 proof_json，保留源桶基线、取货证明、返回意图和存回收据。

`finish` 只接受 `completed` 或 `failed`。成功要求全部计划盒子已按完整输入结算，不能有 held、待结算成品或未决物理阶段。失败只能在真正未动实物的 `ready` 或有完整原料存回证明的 `stored` 完成；部分成品先结算后再失败。终态在同一事务内释放本操作未用预留并写一条 `packing` 总结流水。同状态重复完成返回原记录；不同状态拒绝。

数据库重启时同时保留非终态 craft 与 packing 的预留，继续清理其他临时预留。装盒待恢复不会进入 `assertNoPendingCraft`，不会增加全局库存锁；普通库存读写保持现有行为，既有合成 guard 也不会被装盒结算绕过。目录指纹迁移与启动离线身份合并在装盒待恢复时延后；显式合并正在被该记录引用的 owner 身份被拒绝，直到安全终态。最后一条待处理记录完成后重试延后迁移。

## 权威物理执行接口

`src/packing/executor.js` 导出内部 `PackingExecutor`，不注册任何玩家入口：

```js
const { PackingExecutor } = require('./src/packing/executor')
const executor = new PackingExecutor({ bot, catalog, warehouse, config, debug })
await executor.execute({ box, inputs, signal, check }) // { product, packedInputs }
await executor.recover({ box, inputs, signal, check }) // { product, packedInputs, remainingInputs }
executor.cancel(reason)
executor.isBusy()
```

`box` 是原始已归属空盒的目录行，amount 必须为 1。`inputs` 是同一规划批次的非空、唯一精确指纹行，包含 itemKey、itemId、metaJson、nbtJson、正安全整数 amount；真实规划器附加的 ownerUuid 会保留在 packedInputs 和 remainingInputs 中。执行器检查单盒容量；归属权限、余额预留和跨操作互斥由调用方负责。不得并行启动同一执行器的 execute/recover。

execute 要求当前没有打开的容器、光标为空、背包仅持有精确空盒和全部输入，装备及副手等额外槽位为空。打开前监听原始 open_window/open_screen 和 window_items/container_set_content，并向 warehouse.openQuickShulkerWindow 传递实际持有盒的精确 key。仅接受本次打开的 minecraft:shulker_box、27 盒内槽加 36 玩家槽，以及带 carriedItem 的完整服务端快照。初始盒内必须为空，服务端玩家物品须与请求完全一致。

每个散装源堆叠使用一次 mode 1 shift；接收完整服务端内容后检查源槽减少量恰好等于目标指纹在盒内增加量，包括第 0 槽。其他输入槽不得变化，盒壳颜色、名称和去除 container 后的规范化元数据不得变化。任何剩余、额外、未知、过量物品或光标持物都会失败。`allowPacking` 是 confirmed-window 适配器的显式内部选项，普通合成或 generic 容器调用方仍不能使用潜影盒窗口。

填充结束后通过 click.close 关闭并请求完整玩家菜单。只有实际服务端盒子元数据与已确认的盒内内容完全一致、无散装剩余、光标为空且盒壳不变，才返回 amount=1 的实际 product 及 packedInputs。缺少关闭快照或盒 NBT 仍未更新都不能产生成功证明。容器内容中只跳过严格协议空槽，其他畸形条目一律拒绝；现代耐久物品的容器索引复用玩家物品解码器的伤害 NBT，以保持装入前后的精确身份和可取出性，盒子自身指纹算法不变。

recover 只核验原批次当前实物，不继续填充。它选择唯一匹配原始盒壳的持有盒，用本次服务端菜单证明盒内内容加散装余料恰好等于原 inputs，再关闭核验实际 product。返回已装入的 packedInputs 和 remainingInputs；完全未改变的空盒返回 packedInputs=[]。缺盒、多个匹配盒、缺料、超量或无关物品均拒绝。盒已归还时应由控制器使用持久化存回证明处理，执行器不会猜测。

可选 signal 或同步 check 在异步动作前后检查取消/外部约束。cancel 只阻止后续动作；已发送的 shift 会先等待服务端确认或超时，再执行关闭核验。isBusy 在打开、点击和关闭的等待完成前始终为 true，避免恢复抢占尚未退出的调用。所有拒绝均保留原始 Error 并设置 recoveryRequired=true；失败时尽力关闭窗口，关闭失败不覆盖原错误。debug 回调异常不影响实物操作。超时使用现有 config.craft.confirmTimeoutMs（缺省 5000ms），不改写配置。

## 内部控制器与恢复

```js
new PackingController({ bot, db, catalog, warehouse, config, botId,
  ledger, executor, validateOwner })
controller.run({ owner, actor, items: [{ itemKey, amount }], boxItemKey })
controller.recover()
controller.cancel(reason)
controller.isBusy()
```

controller、planner、executor 和 PackingLedger 从 src/packing/index.js 导出。ledger、executor 可省略；validateOwner 必须提供并验证新请求的 owner/actor，否则拒绝。恢复使用日志里不可变的原 owner，不依赖原 actor 仍有组织成员资格，也不向 actor 交付物品。服务层的 getPackingController() 惰性创建控制器，enqueuePacking(request) 只排内部 packing 任务，不设置 exclusive。组织授权同时检查精确 vault UUID 与组织成员身份，不能用另一个组织名替代目标 UUID。

正常返回为 { status: 'completed', operationId, batches, boxCount, itemCount }。batches 每项为 { batchIndex, product, packedInputs, full }；product 为真实服务端物品元数据，boxCount 是已结算盒数，itemCount 是已装入物品总数。recover() 在无记录时返回 { status: 'empty' }，有记录时返回相同结果结构，status 为 completed 或 failed。中断取货/装盒/回库恢复成功通常结束为 failed，即使已回库的部分刚好包含完整的一盒，也不会伪报整单成功。只有所有正常完整批次已经保存 storedProof 或已结算时，恢复才能完成订单。

run() 失败保留原 Error；已创建日志时附带 operationId、recoveryRequired，以及立即清理的 recovery 结果或 recoveryError。取消不会抢先释放租约；所有已 await 的网络调用先 drain。日志写入或诊断物品解码失败分别留在 journalError 或 observation.inventoryError，不替换原始失败原因。

控制器在第一次 await 前取得自己的租约，整个订单都保留它；仓库互斥锁按批次持有，只有本批全部归还、storedProof 保存并结算后才让其他机器人的普通仓库任务穿插。每批采用独立 120000ms 检查截止时间，清理/恢复另有 120000ms；不以整单两分钟限制多盒请求。底层确认仍使用现有网络/点击超时，没有释放锁后继续运行的 Promise.race。自然失败在当前锁区间内立即尝试一次有界恢复；取消、死亡和断线保留证据待拥有该背包的机器人恢复。

开始前必须验证本地窗口、光标、制作格、装备和背包清洁，再回仓库并通过确认的玩家菜单快照证明空背包。读取 db.getCraftAvailableItems(owner.uuid) 获取该 owner 扣除预留后的全部库存；有效空盒与精确散装都来自同一 owner。每批沿既有已知分组顺序只选择记录量足够的源桶前缀。完整实际源桶槽位必须与已登记槽位一致，不能先刷新漂移记录再绕过严格取货检查。持久化全部 withdrawalIntent 后，调用 withdrawAllocationsLocked 的 requireServerEvidence=true 与 packingSourceChestIds 白名单；白名单只能包含已登记桶，必须配合严格模式，不能搜索或使用白名单以外的桶。普通调用不带此选项时行为不变。

## 有名桶回库证明

src/packing/storage.js 只操作实物证据，不调整余额。初始桶数据必须对应本次打开事件的窗口 ID，采用完整原始服务端槽位验证；无关窗口包不能替代该快照。最终关闭请求完整玩家菜单，严格拒绝藏有元数据的零数量槽位、非空光标、制作格、装备及未知物品。

回库前先保存 verified product/packedInputs，再为每个目的桶保存完整 before 快照和首次固定的 returned 总集合，之后才允许点击。复用 confirmed depositor 的逐次服务端确认，检查目的桶增加等于玩家减少且其他内容未变。每次验证只重读已命名桶；桶中增量加当前剩余背包必须恰好等于 returned，所有桶差值均非负。可在下一次点击前追加目的桶，但不能替换旧基线或缩小原始 held。每轮最多尝试 11 个本地已登记目的桶，跳过无进展桶；没有发现新桶或全仓扫描。

完整回库并确认玩家清空后，先保存 storedProof，再原子 settleBatch。storedProof 已持久化时不会再二次回库或重读历史目的桶，普通后续仓库变化不影响该收据的结算资格。批次 proof_json 保存 normalBatch 标志；中断恢复将其置 false，防止恢复结算完成后崩溃被误当正常订单成功。

withdrawing 用不可变的源桶 before、当前 named after 和当前玩家快照证明精确已取子集，包含合法的零取货；只有证明子集才回库，未取库存不作转换。packing 调用 executor.recover 只读取实际壳体/内容/余料，不继续填盒；空壳原料原样归还，部分成品和全部余料存回后只结算实际 packedInputs。returning 按原基线恢复已转移和仍持有的部分；stored 仅重试账务；ready 只有确认空背包才能释放未用预留。缺失、死亡丢失、外来物品和无法解释的桶差值会保留具体 observation 与剩余预留，不虚构入库或改归 momo。

## 生命周期与普通业务边界

invalidateConnection/handleDeath 取消装盒；spawn/respawn 在普通残余清理之前检查本机器人日志。任务池的 hasInFlightPacking/waitForPackingDrain 与 withPackingRecoveryLease 跟踪真实尚未结束的 Promise，包括生命周期直接恢复及失败后的空背包证据读取。同 botId 替换实例必须等待旧网络调用结束；其他 botId 仍可调度。这是活跃调用租约，不是全仓或持久日志锁。

自己的恢复不能证明清理时，有实物残留则阻止该机器人把它当作普通存取/momo 残余处理；若额外服务端快照证实当前背包空，普通任务仍能开始，日志和预留继续保留。当前普通任务保留这个空背包起点证明，后续取得的普通库存不会在同任务 flushResidual/死亡处理中被重新归类成装盒残留。该证明仅限当前任务；重连后无法确认的新旧残余混合继续保守保留，不能擅自转账。无装盒日志时不创建控制器或日志表，也不改变普通合成恢复保护。

仅管理动作中的 owner 身份迁移受新增保护：有未完装盒的精确 owner 不能被改 UUID 的组织更名或仓库删除转入 momo；大小写/显示名称等同 key 更名及其他 owner 的管理操作仍可进行。普通余额查询、存取、预留与其他机器人操作没有新增全局 packing guard。
