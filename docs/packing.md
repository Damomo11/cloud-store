# 仓库自动装盒

`src/packing/planner.js` 提供独立的纯规划器，将选定 owner 的精确散装物品分配到该 owner 已有的空潜影盒。规划器只计算数据，不读取数据库、不预留或扣除余额，也不操作机器人、背包或容器。当前没有聊天命令、HTTP 路由、按钮或运行时调用入口。

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

`nbtJson` 必须是合法 JSON 对象或 `null`。空盒的 `container` 组件如存在，必须含有空 `data.contents` 数组；任何内容项均视为非空，不会因为其中物品无法识别而忽略。旧式 NBT 或组件中的 `Items` / `items` 容器列表也必须为空；不明列表结构按非空处理。这种保守校验可能拒绝自定义插件里用途不同的同名字段。

规划器抛错拒绝无效 owner、未知精确指纹、无效或溢出的数量、非法元数据、空盒伪装、库存不足、空盒不足，以及把任何潜影盒装入潜影盒的请求。所有数量及聚合运算必须保持为安全整数。单次计划最多 `MAX_PACKING_BOXES = 256` 盒，超限在展开槽位前拒绝。

## 后续内部执行约定

规划结果是可能过期的库存快照。内部执行层应在现有仓库互斥锁内重新核验 owner 权限、可用库存和精确空盒，并原子预留 `allocations`。单盒作为持久化批次：先记录意图，取回该盒及其 `inputs`，依据服务端确认填入 27 格，核验实际内容和盒子原有元数据，再将成品归还同一仓库。余额转换必须以已确认的实际成品为依据，并保持重试幂等和原 owner 归属。

物理执行必须独立检查真实槽位容量、服务端回包、光标状态和结果内容；规划成功不构成物理操作完成或余额已转换的证据。中断恢复应保留批次证据和预留，仅在实物状态得到证明后结算或释放。执行接口保持内部使用，不注册玩家入口。
