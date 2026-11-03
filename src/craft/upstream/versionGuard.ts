// 备料系统 · 阶段2 — W0 首步：minecraft-data 版本校验（阻断性）。
// 依据 .kiro/specs/material-preparation-phase2/design.md §1「技术前提核实结论」与 §3.1，
// 以及 requirements.md Requirement 1.5：
//   RecipeGraph 使用与生产服务端一致的 minecraft-data 1.21.11 registry 进行名称校验与归一化；
//   若 minecraft-data 无法提供 1.21.11 registry，则拒绝启动并记录版本不匹配错误。
//
// 本模块只做一件事：加载 minecraft-data('1.21.11') 并校验能取到 items/blocks registry，
// 供 RecipeGraph / CraftPlanner 等上层在启动期调用；取不到则抛出 VersionMismatchError，
// 由上层据此拒绝启用 preparation 功能。

import minecraftData from "minecraft-data";

/** 备料系统锁定的 Minecraft 版本（见 design.md §0/§1）。 */
export const PREPARATION_MC_VERSION = "1.21.11" as const;

/** minecraft-data 索引数据类型（`minecraftData(version)` 的返回值）。 */
export type McRegistry = ReturnType<typeof minecraftData>;

/**
 * 版本不匹配错误：minecraft-data 无法提供 1.21.11 registry 时抛出。
 * 上层（RecipeGraph 加载 / 服务端启动路径）捕获后应拒绝启用 preparation 功能。
 */
export class VersionMismatchError extends Error {
  /** 期望的 Minecraft 版本。 */
  readonly expectedVersion: string;

  constructor(message: string, expectedVersion: string = PREPARATION_MC_VERSION) {
    super(message);
    this.name = "VersionMismatchError";
    this.expectedVersion = expectedVersion;
  }
}

/** 加载后缓存，避免重复构造 registry。 */
let cachedRegistry: McRegistry | null = null;

/**
 * 加载并校验 minecraft-data 的 1.21.11 registry。
 *
 * 校验点（对齐 Requirement 1.5「能取到 items/blocks registry」）：
 * 1. `minecraftData('1.21.11')` 必须返回非空对象（该版本存在于 minecraft-data 数据集中）；
 * 2. `itemsByName` 必须存在且至少含一个物品；
 * 3. `blocksByName` 必须存在且至少含一个方块。
 *
 * 任一校验失败均抛出 {@link VersionMismatchError}，并在抛出前记录版本不匹配错误日志。
 *
 * @returns 校验通过的 minecraft-data 1.21.11 索引数据。
 * @throws {VersionMismatchError} 当 minecraft-data 无法提供可用的 1.21.11 registry 时。
 */
export function loadMcRegistry(): McRegistry {
  if (cachedRegistry) {
    return cachedRegistry;
  }

  let registry: McRegistry | null | undefined;
  try {
    registry = minecraftData(PREPARATION_MC_VERSION);
  } catch (error) {
    const message = (error as Error)?.message ?? String(error);
    throw fail(`加载 minecraft-data('${PREPARATION_MC_VERSION}') 时抛出异常: ${message}`);
  }

  if (!registry) {
    throw fail(`minecraft-data 未提供版本 '${PREPARATION_MC_VERSION}' 的 registry`);
  }

  const itemCount = countKeys(registry.itemsByName);
  if (itemCount === 0) {
    throw fail(`minecraft-data('${PREPARATION_MC_VERSION}') 的 itemsByName registry 为空或缺失`);
  }

  const blockCount = countKeys(registry.blocksByName);
  if (blockCount === 0) {
    throw fail(`minecraft-data('${PREPARATION_MC_VERSION}') 的 blocksByName registry 为空或缺失`);
  }

  cachedRegistry = registry;
  return registry;
}

/**
 * 判断某物品名是否存在于 1.21.11 items registry（供 RecipeGraph 名称校验/归一化用）。
 */
export function isKnownItem(name: string): boolean {
  const registry = loadMcRegistry();
  return Boolean(registry.itemsByName?.[name]);
}

/**
 * 判断某方块名是否存在于 1.21.11 blocks registry。
 */
export function isKnownBlock(name: string): boolean {
  const registry = loadMcRegistry();
  return Boolean(registry.blocksByName?.[name]);
}

/** 仅供测试：清除缓存，使下次 loadMcRegistry 重新构造 registry。 */
export function resetRegistryCacheForTest(): void {
  cachedRegistry = null;
}

// ---------------------------------------------------------------------------
// 内部辅助
// ---------------------------------------------------------------------------

function countKeys(map: Record<string, unknown> | undefined | null): number {
  if (!map || typeof map !== "object") {
    return 0;
  }
  return Object.keys(map).length;
}

function fail(reason: string): VersionMismatchError {
  console.error(`[versionGuard] 版本不匹配: ${reason}`);
  return new VersionMismatchError(reason);
}
