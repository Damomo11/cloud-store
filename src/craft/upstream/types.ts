// 备料系统 · 阶段2（采集 / 合成 / 全流程闭环）的自研合成引擎核心共享类型。
// 依据 .kiro/specs/material-preparation-phase2/DESIGN.md §3.1 / §3.2 与 §4 四层闸门定义，
// 供 RecipeGraph / CraftPlanner / PreparationService / Preparation_API / GUI 直接 import。
// 仅放类型声明；运行期常量与逻辑在各自的组件中。
//
// 规划真值源：以 recipes.json(1.21.4) 的物品名为唯一真值源（去 minecraft: 前缀归一化），
// 而非 minecraft-data 的 itemsByName。

// ---------------------------------------------------------------------------
// §3.1 RecipeGraph —— 归一化的可用配方
// ---------------------------------------------------------------------------

/**
 * 可用配方类型。无熔炉/切石/锻造，一期只保留 shaped/shapeless（见 D3）。
 * transmute/smelting/blasting/campfire_cooking/smoking/stonecutting/
 * smithing_transform/special/decorated_pot 在 RecipeGraph 加载期被过滤，永不出现于此。
 */
export type UsableRecipeType = "shaped" | "shapeless";

/** 配方产物：物品名 + 单次合成产出数量（如 planks×4、stick×4）。 */
export interface RecipeResult {
  /** 物品名（归一化，去 minecraft: 前缀）。 */
  name: string;
  /** 单次触发该配方产出的数量（≥1）。 */
  count: number;
}

/**
 * 配方的单个输入位。
 * names = 候选物品名集合：ingredient 为 {tag,items} 时展开为 tag 候选集，
 * 单物品时为长度 1 的数组。候选集合中任一物品可得即视为该输入满足（对齐 MC tag 语义）。
 */
export interface RecipeInput {
  /** 该输入位的候选物品名集合（归一化）；长度 ≥1。 */
  names: string[];
  /** 该输入位所需数量（同一物品在配方中出现多次时已合并计数）。 */
  count: number;
}

/**
 * 一条归一化后的可用配方（RecipeGraph.recipesByResult 的元素）。
 * 例：iron_block→9 iron_ingot 的反拆本身就是 recipesByResult['iron_ingot'] 里的一条 shapeless 配方。
 */
export interface UsableRecipe {
  /** 稳定配方标识（用于 CraftStep.recipeId 回指与去重）。 */
  id: string;
  type: UsableRecipeType;
  result: RecipeResult;
  /** 归一化输入位集合。 */
  inputs: RecipeInput[];
  /** Whether this concrete recipe needs a 3x3 crafting table. */
  requiresTable: boolean;
  /** Main result and deterministic returned containers from one trigger. */
  outputs?: RecipeResult[];
}

// ---------------------------------------------------------------------------
// §4 四层闸门 —— 叶子采集方式与不可达原因分类
// ---------------------------------------------------------------------------

/**
 * 叶子原材料的采集方式（对齐 data/resource-source-map.json 的 method 取值）。
 * 第四层闸门据此派执行器：
 * - mine_underground / 方块类 harvest_biome → Collect_Executor
 * - 陆生动物 mob_drop → Combat_Executor
 * - egg / milk_bucket 的 mob_interact → Interact_Executor
 * - farm_crop → 一期 unreachable（D6）
 */
export type CollectMethod =
  | "mine_underground"
  | "harvest_biome"
  | "harvest_structure"
  | "mob_drop"
  | "mob_interact"
  | "farm_crop"
  | (string & {});

/** Lifecycle state for a direct collection capability. */
export type DirectCollectionStatus = "unsupported" | "experimental" | "supported";

/** How a direct collection executor must validate the resulting pickup. */
export type DirectPickupValidation = "exact_target_item" | "declared_drop";

/** World dependency declared by a direct collection capability. */
export type DirectCapabilityDependency = "biome" | "structure" | "dimension" | "entity";

/**
 * 采集工具描述（对齐 resource-source-map.json 条目的 tool 子对象）。
 * material 决定装备哪种工具：矿石=时运III镐、沙土=时运铲、原木=斧、花草=手（default）。
 */
export interface CollectTool {
  /** 目标是否有可破坏的方块形态。 */
  hasBlockForm: boolean;
  /** 破坏以获得该物品的源方块名；无方块形态为 null。 */
  sourceBlock: string | null;
  /** 采集材质标签（如 mineable/pickaxe、mineable/axe、default）。 */
  material: string;
  /** 特定采集工具约束（数字化 registry id 列表）；无约束为 null。 */
  harvestTools: string[] | null;
}

/** 采集的 Y 高度区间；不限制时两端为 null。 */
export interface YRange {
  min: number | null;
  max: number | null;
}

/** 声明式结构资源堆采集约束；Bot 端仍须独立严格归一化后才可签发破坏许可。 */
export interface StructureHarvestProfile {
  profileId: string;
  dimension: "overworld";
  structures: string[];
  markerGroups: Array<{
    label: string;
    blocks: string[];
    minCount: number;
  }>;
  locateRadius: number;
  verificationRadius: number;
  targetRadius: number;
  targetBlocks: string[];
  navigation: { allowPathDigging: false };
}

/**
 * CraftPlan 中一条需采集的叶子原材料条目（Collect_Gap）。
 * 由 CraftPlanner 判定叶子可达后附上采集方式与定位信息，交给执行器执行。
 */
export interface CollectGap {
  /** 需采集的叶子物品名（归一化）。 */
  name: string;
  /** 净缺口数量（已扣减库存后仍需采集的量）。 */
  qty: number;
  /** 采集方式（派执行器依据）。 */
  method: CollectMethod;
  /** 采集工具描述；无方块形态/不适用时为 null。 */
  tool: CollectTool | null;
  /** 破坏以获得该物品的源方块名；不适用为 null。 */
  sourceBlock: string | null;
  /** 目标群系集合（如 minecraft:savanna）；无群系约束为 null。 */
  biomes: string[] | null;
  /** 采集 Y 高度区间；无约束为 null。 */
  yRange: YRange | null;
  /**
   * mob_drop 时掉落该物品的生物名（如 beef→cow）；非 mob_drop 为 null。
   * 供 Combat_Executor 的 collect_hunt 命令携带 animals=[mobName]（与白名单取交集）。
   */
  mobName: string | null;
  /** harvest_structure 的精确结构 profile；其他 method 缺省或为 null。 */
  structureProfile?: StructureHarvestProfile | null;
  /** Direct capability tool requirement, when the source needs a specific tool. */
  requiredTool?: string;
  /** Direct capability enchantment requirement, when pickup semantics require it. */
  requiredEnchantment?: string;
  /** Direct capability pickup proof required by the executor. */
  pickupValidation?: DirectPickupValidation;
  /** Direct capability consumables, expressed per requested target item. */
  consumables?: Array<{ name: string; quantityPerTarget: number }>;
  /** Lifecycle state of the direct capability used to create this gap. */
  capabilityStatus?: DirectCollectionStatus;
  /** World dependency declared by the direct capability, when present. */
  dependency?: DirectCapabilityDependency;
}

/**
 * 不可达原因类别（Requirement 5.5）。Preparation_Tab 对每个不可达条目标注其一：
 * - excluded：排除项（硬排除，如钻石矿/下界矿/怪物或水生白名单外，或 poolStatus=excluded）
 * - sealed_tier：封存 tier（poolStatus=sealed，一期不做的 T1/T2）
 * - no_furnace_intermediate：无熔炉中间产物（需冶炼且库存无法反拆得到）
 * - out_of_collect_range：超出采集范围（farm_crop、复合物、无采集路径等）
 * - mob_or_aquatic_excluded：怪物或水生排除（怪物掉落与水生生物一期不获取）
 */
export type ReasonCategory =
  | "excluded"
  | "sealed_tier"
  | "no_furnace_intermediate"
  | "out_of_collect_range"
  | "mob_or_aquatic_excluded";

/** 不可达原因类别 → 中文展示标签（供 GUI 直接使用）。 */
export const REASON_CATEGORY_LABELS: Record<ReasonCategory, string> = {
  excluded: "排除项",
  sealed_tier: "封存 tier",
  no_furnace_intermediate: "无熔炉中间产物",
  out_of_collect_range: "超出采集范围",
  mob_or_aquatic_excluded: "怪物或水生排除",
};

/** CraftPlan 中一条不可达条目及其原因。 */
export interface Unreachable {
  /** 不可达的物品名（归一化）。 */
  name: string;
  /** 该物品在本次规划中缺口数量。 */
  quantity: number;
  /** 人类可读的具体原因说明。 */
  reason: string;
  /** 原因类别（Requirement 5.5 的五选一）。 */
  category: ReasonCategory;
}

// ---------------------------------------------------------------------------
// §3.2 CraftPlan —— 库存感知 + 正反向递归规划器的产出
// ---------------------------------------------------------------------------

/**
 * CraftPlan 中一条合成步骤（Craft_Step），拓扑序（叶子 → 成品）中的一层触发。
 * 由 Crafting_Executor 按顺序自底向上执行。
 */
export interface CraftStep {
  /** 触发的配方标识（回指 UsableRecipe.id）。 */
  recipeId: string;
  /** 该步骤产出的产物（物品名 + 目标产出数量）。 */
  result: RecipeResult;
  /** Preserved through branch cloning and step merging for workstation checks. */
  requiresTable: boolean;
  /** Gross produced items, including returned containers, for one trigger. */
  outputs?: RecipeResult[];
  /** 需触发该配方的次数 times = ceil(净缺口 / result.count)。 */
  times: number;
  /** 触发所需的输入位集合（与配方 inputs 同构，count 已乘以 times 的语义由消费方约定）。 */
  inputs: RecipeInput[];
}

/** 规划期实际从融合库存消费的物品用量；执行期再拆分到具体 supply 容器。 */
export interface InventoryUse {
  /** 归一化物品名。 */
  name: string;
  /** 从库存满足的数量。 */
  quantity: number;
}

/** 一条持久化的库存搬运腿：从 supply 容器取出后送入缓冲桶。 */
export interface PreparationTransfer {
  sourceContainerId: string;
  itemName: string;
  quantity: number;
  location: {
    inShulker: boolean;
    shulkerPath: { outerSlot: number; innerSlot: number } | null;
  };
}

/**
 * CraftPlanner 的规划产出（DESIGN.md §3.2）。
 * - collectGaps：需采集的叶子（已附 method/tool 等）。
 * - craftSteps：拓扑序（叶子→成品）合成步骤。
 * - unreachable：不可达条目及原因（非空 → Preparation_Service 整单拒绝，见 Req 5.2）。
 * - estimatedSlots：量级预检用格子数（对比缓冲区总空位，见 Req 6）。
 */
export interface CraftPlan {
  /** 是否可完整完成（等价于 unreachable 为空）。 */
  ok: boolean;
  /** 下单目标物品与数量。 */
  target: {
    name: string;
    quantity: number;
  };
  /** 实际由融合库存满足的物品用量（后续拆分为 supply→buffer 搬运腿）。 */
  inventoryUses: InventoryUse[];
  /** 需采集的叶子集合。 */
  collectGaps: CollectGap[];
  /** 拓扑序合成步骤（叶子 → 成品）。 */
  craftSteps: CraftStep[];
  /** 不可达条目及原因。 */
  unreachable: Unreachable[];
  /** 量级预检用格子数。 */
  estimatedSlots: number;
}

// ---------------------------------------------------------------------------
// §7 决策层接入 —— 备料任务与任务状态机（Task_Queue / Preparation_Service 共享）
// ---------------------------------------------------------------------------

/**
 * 备料任务状态机取值（Requirement 18.2 / DESIGN §7）。
 * 顺序推进：planning → collecting → hauling → crafting → depositing → done；
 * 任一阶段不可恢复失败 → failed。done 与 failed 为终态。
 */
export type TaskState =
  | "planning"
  | "collecting"
  | "hauling"
  | "crafting"
  | "depositing"
  | "done"
  | "failed"
  | "cancelled";

/** 终态集合。启动恢复据此判定"进行中任务"（Req 19.3）。 */
export const TERMINAL_TASK_STATES: readonly TaskState[] = ["done", "failed", "cancelled"] as const;

export type CancellationDisposition =
  | "pending"
  | "executor_ack"
  | "timeout_release"
  | "delivery_failed";

export interface PreparationCancellation {
  requestedAt: number;
  disposition: CancellationDisposition;
  acknowledgedAt?: number;
  botId?: string;
}

export interface PreparationCommandTelemetry {
  command?: { kind?: string; requestId?: string };
  wallClockMs?: number;
  timeline?: Array<Record<string, unknown>>;
  phaseTotals?: Record<string, number>;
  navStats?: Record<string, unknown>;
  flights?: Array<Record<string, unknown>>;
  relays?: number;
}

/**
 * 归属身份 tuple（四道并行链路设计 §4.3 «Persistent identity and affinity»）。
 *
 * 为什么要持久化在任务上：四条链路只有在「每张单与每条子命令都带可核验的归属」时才能彼此隔离。
 * 第 2 轮实测里一张单根本无法绑定到某个 bot，于是错误 bot 的终态事件会把正确事件的去重键吃掉。
 * 本阶段（B2）只负责**持久化 + 硬 affinity 派发选择**；事件围栏/校验是 B3，不在此处实现。
 *
 * 缺省语义（向后兼容，旧持久化与非 campaign 单不受影响）：
 *   runId/groupId/itemId/laneId/requiredBotId/expectedBotGeneration → null；assignmentEpoch → 1。
 */
export interface TaskAffinity {
  /** campaign run 身份；非 campaign 单为 null。 */
  runId: string | null;
  /** 清单分组（G01..G12）；无为 null。 */
  groupId: string | null;
  /** run 内稳定的单物品身份；无为 null。 */
  itemId: string | null;
  /** 链路号 lane-1..lane-4；无为 null。 */
  laneId: string | null;
  /**
   * 硬 affinity：**不是偏好**。非空时派发必须精确选中该 bot，选不到即失败
   * （required_bot_unavailable），绝不静默回退 pickIdleBot —— 换 bot 会让库存基线与事件出处
   * 全部失效（换的那个 bot 背包里没有本单的中间产物，它的事件也不该被当作本单的进度）。
   */
  requiredBotId: string | null;
  /** 归属代次：从 1 起，每次显式恢复/重派 +1。旧持久化缺省视为 1。 */
  assignmentEpoch: number;
  /** 作出本次归属时 bot 的生命周期代次；取不到为 null。 */
  expectedBotGeneration: number | null;
}

/** Physical facilities exclusively assigned to one campaign lane. */
export interface LaneResourceAllocation {
  bufferContainerIds: string[];
  workstationContainerIds: string[];
  outputContainerIds: string[];
  trashContainerIds: string[];
}

export interface DepositOwner {
  runId: string | null;
  itemId: string | null;
  laneId: string | null;
  botId: string;
  assignmentEpoch: number;
  expectedBotGeneration: number | null;
}

export interface DepositOperation {
  operationId: string;
  itemName: string;
  requested: number;
  authorizedContainerIds: string[];
  owner: DepositOwner;
}

export interface DepositContainerDelta {
  operationId: string;
  containerId: string;
  itemName: string;
  requested: number;
  beforeCount: number;
  afterCount: number;
  delta: number;
}

export interface DepositEvidence extends DepositOperation {
  deposited: number;
  residual: number;
  containerDeltas: DepositContainerDelta[];
}

/** A fenced execution attempt retained on the old task for crash/audit accounting. */
export interface RecoveryAttemptRecord {
  disposition: "recovery_fenced";
  reason: string;
  fencedAt: number;
  runId: string | null;
  itemId: string | null;
  laneId: string | null;
  botId: string;
  assignmentEpoch: number;
  expectedBotGeneration: number | null;
  operationId: string | null;
}

/**
 * 一条备料任务记录（Preparation_Task）。
 * 含唯一 requestId、目标物品与数量、状态、占用 bot、进度与 CraftPlan（见术语表）。
 * 由 Task_Queue 持久化到 data/preparation_tasks.json（原子写），Preparation_Service 驱动状态机。
 */
export interface PreparationTask extends TaskAffinity {
  /** Campaign-only facility ownership; legacy/non-campaign tasks use null. */
  laneResources: LaneResourceAllocation | null;
  /** Server-issued commit identity, persisted before craft/deliver enqueue. */
  depositOperation: DepositOperation | null;
  /** Accepted physical reconciliation. Present for both successful and verification-failed commits. */
  depositEvidence: DepositEvidence | null;
  /** 唯一请求标识（幂等去重键，Req 18.4）。 */
  requestId: string;
  /** 下单目标物品与数量。 */
  target: {
    name: string;
    quantity: number;
  };
  /** 任务状态机当前取值。 */
  state: TaskState;
  /** 是否为玩家手动提交的任务；手动任务在 FIFO 中排在自动任务之前（Req 18.1）。 */
  manual: boolean;
  /** Runner 验证模式：规划时忽略融合库存，强制走真实采集链。 */
  forceCollect?: boolean;
  /** 当前以 preparation reasoner 独占的 bot；未派发为 null。 */
  assignedBot: string | null;
  /** 该任务的 CraftPlan；下单预览产出后落库，未规划为 null。 */
  plan: CraftPlan | null;
  /**
   * 采集游标：已完成采集的 collectGaps 数量 = 下一个待采 gap 的下标（阶段2 编排）。
   * 采集阶段逐个 gap 下发 collect_* 命令，收到该 gap 的 collect_completed 后 +1；
   * 达到 collectGaps.length 即全部采集完成，转入合成。持久化以支持重启后续采。
   */
  collectCursor: number;
  /** 规划库存用量拆出的 supply→buffer 搬运腿；按 transferCursor 串行执行。 */
  transfers: PreparationTransfer[];
  /** 已完成搬运腿数量 = 下一条待搬运腿下标。 */
  transferCursor: number;
  /**
   * 因来源/缓冲区数据陈旧（融合库存与实际不符）而就地重规划的次数，搬运期与合成期共用同一额度。
   * 每次重算并重发 +1，达上限仍失败才整单收敛为 failed。旧持久化缺省视为 0。
   * 亦作为搬运子请求 id 的代次后缀，使重规划前的迟到事件不会被当作当代次接受。
   */
  replanCount?: number;
  /** 下单玩家名（供成品交付后私信通知，Req 16.4）；无则 null。 */
  orderedBy: string | null;
  /**
   * 启动恢复标记：进程重启时读入的非终态任务被标记"中断待重派"（Req 19.3）。
   * 正常入队任务为 false，由启动加载置 true 供 Preparation_Service 重派。
   */
  interrupted: boolean;
  /** 入队单调序号，保证 FIFO 顺序在落盘/重载后稳定（Req 18.1 / 19.1）。 */
  seq: number;
  /** 最近一次失败原因；无为 null。 */
  lastError: string | null;
  /** 取消请求与物理执行器确认的持久化处置状态。 */
  cancellation?: PreparationCancellation;
  /** 最近 32 条采集命令的有界终态遥测；原始 5s 心跳不进入任务持久化。 */
  telemetry?: PreparationCommandTelemetry[];
  /** Recovery fences are durable so the replaced physical attempt remains attributable. */
  recoveryAttempts?: RecoveryAttemptRecord[];
  /** 创建时间戳（ms）。 */
  createdAt: number;
  /** 最近更新时间戳（ms）。 */
  updatedAt: number;
  /**
   * 当前阶段的开始时间戳（ms）——阶段 GC 超时判定的基准。
   * 不能用 updatedAt：任何无关补丁（站位回写、重规划记账等）都会刷新 updatedAt，
   * 把已经卡死的任务的超时线一再往后推。仅在状态真正变化时更新。旧持久化缺省回退 updatedAt。
   */
  stageStartedAt?: number;
}
