/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbmangrove
 * - 含数据结构版本号与 v1 → v2 → v3 升级迁移逻辑（升级时按 version().stores() 补齐索引）
 * - v3：林业站权属宗地（parcels）与宗地—地块挂接关系（parcelLinks）
 * - 提供各表增删改查、整库快照导入导出与重置
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie';
import type { Plot } from '../types/plot';
import type { Seedling } from '../types/seedling';
import type { Planting } from '../types/planting';
import type { Survey } from '../types/survey';
import type { Replant, ReplantState } from '../types/replant';
import type { Parcel } from '../types/parcel';
import type { ParcelLink } from '../types/parcelLink';
import { rateLevel } from './rate';
import { replantBlockReason } from './parcel';
import { nowIso, today } from './id';
import { seedDatabase } from './seed';

/** 数据库名 */
export const DB_NAME = 'gbmangrove';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3;

/** 数据行结构修订号 */
export const ROW_REVISION = 3;

class MangroveDatabase extends Dexie {
  plots!: Table<Plot, string>;
  seedlings!: Table<Seedling, string>;
  plantings!: Table<Planting, string>;
  surveys!: Table<Survey, string>;
  replants!: Table<Replant, string>;
  parcels!: Table<Parcel, string>;
  parcelLinks!: Table<ParcelLink, string>;

  constructor() {
    super(DB_NAME);

    // ---------- v1：初版结构 ----------
    this.version(1).stores({
      plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt',
      seedlings: 'id, plotId, species, source, arrivalDate',
      plantings: 'id, plotId, seedlingId, plantDate',
      surveys: 'id, plotId, round, date',
      replants: 'id, plotId, planDate, state',
    });

    // ---------- v2：补齐索引与回写字段，并迁移历史数据 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt, updatedAt',
        seedlings: 'id, plotId, species, source, arrivalDate, quantity',
        plantings: 'id, plotId, seedlingId, plantDate, spacingM',
        // 复合索引 [plotId+round]：按地块 + 测次快速取验收记录
        surveys: 'id, plotId, [plotId+round], date, grade',
        replants: 'id, plotId, planDate, state, species',
      })
      .upgrade(async (tx) => {
        // 迁移 1：补齐 revision / createdAt / updatedAt
        const tables = [
          tx.table('plots'),
          tx.table('seedlings'),
          tx.table('plantings'),
          tx.table('surveys'),
          tx.table('replants'),
        ];
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = ROW_REVISION;
            if (typeof row.createdAt !== 'string') row.createdAt = nowIso();
            if (typeof row.updatedAt !== 'string') row.updatedAt = row.createdAt;
          });
        }
        // 迁移 2：地块补齐「缺株数 / 最近补植日期」回写字段
        await tx.table('plots').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.missingCount !== 'number') row.missingCount = 0;
          if (typeof row.lastReplantDate !== 'string') row.lastReplantDate = '';
        });
        // 迁移 3：验收记录补齐成活率等级字段
        await tx.table('surveys').toCollection().modify((row: Record<string, unknown>) => {
          const rate = typeof row.survivalRate === 'number' ? row.survivalRate : 0;
          if (typeof row.grade !== 'string') row.grade = rateLevel(rate);
          if (typeof row.gradeManual !== 'boolean') row.gradeManual = false;
        });
      });

    // ---------- v3：林业站权属宗地 + 宗地—地块挂接，按原地块编号回填历史宗地 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt, updatedAt',
        seedlings: 'id, plotId, species, source, arrivalDate, quantity',
        plantings: 'id, plotId, seedlingId, plantDate, spacingM',
        surveys: 'id, plotId, [plotId+round], date, grade',
        replants: 'id, plotId, planDate, state, species',
        parcels: 'id, parcelCode, ownerName, status, effectiveDate',
        parcelLinks: 'id, parcelId, plotId, linkType',
      })
      .upgrade(async (tx) => {
        await backfillHistoricParcels({
          plots: tx.table('plots'),
          parcels: tx.table('parcels'),
          parcelLinks: tx.table('parcelLinks'),
        });
      });
  }
}

export const db = new MangroveDatabase();

/* --------------------- 历史宗地回填（v3 升级 / 老快照导入共用） --------------------- */

export interface ParcelBackfillAccessor {
  plots: Pick<Table<Plot, string>, 'toArray' | 'bulkPut'>;
  parcels: Pick<Table<Parcel, string>, 'bulkPut'>;
  parcelLinks: Pick<Table<ParcelLink, string>, 'bulkPut'>;
}

/**
 * 已有数据没有宗地归属时：按原地块编号回填历史宗地（宗地编号沿用原地块 id），
 * 并建 direct 一一对应挂接；回填不出的地块（编号 / 面积无效）置只读保留。
 * 返回回填宗地数与置只读的地块数。
 */
export async function backfillHistoricParcels(accessor: ParcelBackfillAccessor): Promise<{
  parcelCount: number;
  readonlyPlotCount: number;
}> {
  const plots = await accessor.plots.toArray();
  const stamp = nowIso();
  const parcels: Parcel[] = [];
  const links: ParcelLink[] = [];
  const readonlyPlots: Plot[] = [];

  for (const plot of plots) {
    const code = String(plot.id ?? '').trim();
    if (code === '' || typeof plot.areaMu !== 'number' || !(plot.areaMu > 0)) {
      readonlyPlots.push({ ...plot, readonly: true, updatedAt: stamp, revision: ROW_REVISION });
      continue;
    }
    parcels.push({
      id: `parcel-hist-${code}`,
      parcelCode: code,
      ownerName: '历史权属（待林业站核对）',
      areaMu: plot.areaMu,
      boundaries: '',
      effectiveDate: '',
      status: '正常',
      holdReason: '',
      source: 'upgrade-backfill',
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    });
    links.push({
      id: `plink-hist-${code}`,
      parcelId: `parcel-hist-${code}`,
      plotId: code,
      linkType: 'direct',
      team: '',
      splitAreaMu: 0,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    });
  }

  if (parcels.length > 0) await accessor.parcels.bulkPut(parcels);
  if (links.length > 0) await accessor.parcelLinks.bulkPut(links);
  if (readonlyPlots.length > 0) await accessor.plots.bulkPut(readonlyPlots);
  return { parcelCount: parcels.length, readonlyPlotCount: readonlyPlots.length };
}

/* ------------------------------ 初始化与播种 ------------------------------ */

let initPromise: Promise<void> | null = null;

/**
 * 打开数据库并在首屏自动播种演示数据（幂等：仅当主表为空时播种）。
 * 多次调用共用同一个 Promise，避免并发重复播种。
 */
export function initDatabase(): Promise<void> {
  if (initPromise === null) {
    initPromise = (async (): Promise<void> => {
      await db.open();
      // 首屏自动播种演示数据：仅当主表为空时执行（幂等）
      if ((await db.plots.count()) === 0) {
        await seedDatabase();
      }
    })();
  }
  return initPromise;
}

/* -------------------------------- 地块 -------------------------------- */

export async function listPlots(): Promise<Plot[]> {
  const rows = await db.plots.toArray();
  return rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

export async function getPlot(id: string): Promise<Plot | undefined> {
  return db.plots.get(id);
}

export async function putPlot(row: Plot): Promise<void> {
  await db.plots.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function patchPlot(id: string, patch: Partial<Plot>): Promise<void> {
  await db.plots.update(id, { ...patch, updatedAt: nowIso() });
}

/** 删除地块并级联清理其下苗木批次、栽植、验收、补植计划与宗地挂接边 */
export async function removePlot(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.plots, db.seedlings, db.plantings, db.surveys, db.replants, db.parcelLinks],
    async () => {
      await db.seedlings.where('plotId').equals(id).delete();
      await db.plantings.where('plotId').equals(id).delete();
      await db.surveys.where('plotId').equals(id).delete();
      await db.replants.where('plotId').equals(id).delete();
      await db.parcelLinks.where('plotId').equals(id).delete();
      await db.plots.delete(id);
    },
  );
}

/* ------------------------------ 权属宗地 ------------------------------ */

export async function listParcels(): Promise<Parcel[]> {
  const rows = await db.parcels.toArray();
  return rows.sort((a, b) => a.parcelCode.localeCompare(b.parcelCode, 'zh-Hans-CN'));
}

export async function getParcel(id: string): Promise<Parcel | undefined> {
  return db.parcels.get(id);
}

export async function putParcel(row: Parcel): Promise<void> {
  await db.parcels.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

/** 删除宗地并级联清理其挂接边（地块 / 栽植 / 验收不动，权属台账只管台账侧） */
export async function removeParcel(id: string): Promise<void> {
  await db.transaction('rw', db.parcels, db.parcelLinks, async () => {
    await db.parcelLinks.where('parcelId').equals(id).delete();
    await db.parcels.delete(id);
  });
}

/* --------------------------- 宗地—地块挂接 --------------------------- */

export async function listParcelLinks(): Promise<ParcelLink[]> {
  return db.parcelLinks.toArray();
}

export async function listLinksByParcel(parcelId: string): Promise<ParcelLink[]> {
  return db.parcelLinks.where('parcelId').equals(parcelId).toArray();
}

export async function putParcelLink(row: ParcelLink): Promise<void> {
  await db.parcelLinks.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removeParcelLink(id: string): Promise<void> {
  await db.parcelLinks.delete(id);
}

/* ------------------------------ 苗木批次 ------------------------------ */

export async function listSeedlings(): Promise<Seedling[]> {
  const rows = await db.seedlings.toArray();
  return rows.sort((a, b) => b.arrivalDate.localeCompare(a.arrivalDate));
}

export async function listSeedlingsByPlot(plotId: string): Promise<Seedling[]> {
  const rows = await db.seedlings.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => b.arrivalDate.localeCompare(a.arrivalDate));
}

export async function putSeedling(row: Seedling): Promise<void> {
  await db.seedlings.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removeSeedling(id: string): Promise<void> {
  await db.transaction('rw', db.seedlings, db.plantings, async () => {
    // 该批次已被栽植记录引用时一并清理，避免出现悬空引用
    await db.plantings.where('seedlingId').equals(id).delete();
    await db.seedlings.delete(id);
  });
}

/* ------------------------------- 栽植 ------------------------------- */

export async function listPlantings(): Promise<Planting[]> {
  const rows = await db.plantings.toArray();
  return rows.sort((a, b) => b.plantDate.localeCompare(a.plantDate));
}

export async function listPlantingsByPlot(plotId: string): Promise<Planting[]> {
  const rows = await db.plantings.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => b.plantDate.localeCompare(a.plantDate));
}

export async function putPlanting(row: Planting): Promise<void> {
  await db.plantings.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removePlanting(id: string): Promise<void> {
  await db.plantings.delete(id);
}

/* ------------------------------- 验收 ------------------------------- */

export async function listSurveys(): Promise<Survey[]> {
  const rows = await db.surveys.toArray();
  return rows.sort((a, b) => a.plotId.localeCompare(b.plotId) || a.round - b.round);
}

export async function listSurveysByPlot(plotId: string): Promise<Survey[]> {
  const rows = await db.surveys.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => a.round - b.round);
}

export async function putSurvey(row: Survey): Promise<void> {
  const grade = row.gradeManual ? row.grade : rateLevel(row.survivalRate);
  await db.surveys.put({ ...row, grade, updatedAt: nowIso(), revision: ROW_REVISION });
}

/** 批量调整成活率等级（人工复核覆盖） */
export async function patchSurveyGrades(ids: string[], grade: Survey['grade']): Promise<void> {
  if (ids.length === 0) return;
  const rows = await db.surveys.bulkGet(ids);
  const stamp = nowIso();
  const next = rows
    .filter((row): row is Survey => row !== undefined)
    .map((row) => ({ ...row, grade, gradeManual: true, updatedAt: stamp }));
  if (next.length > 0) await db.surveys.bulkPut(next);
}

export async function removeSurvey(id: string): Promise<void> {
  await db.surveys.delete(id);
}

/* ------------------------------ 补植计划 ------------------------------ */

export async function listReplants(): Promise<Replant[]> {
  const rows = await db.replants.toArray();
  return rows.sort((a, b) => a.planDate.localeCompare(b.planDate));
}

export async function listReplantsByPlot(plotId: string): Promise<Replant[]> {
  const rows = await db.replants.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => a.planDate.localeCompare(b.planDate));
}

export async function putReplant(row: Replant): Promise<void> {
  await db.replants.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removeReplant(id: string): Promise<void> {
  await db.replants.delete(id);
}

/**
 * 补植完成回写：
 * 1）扣减地块缺株数；2）写入最近补植日期；3）按补植后的总株数重算最新一次验收的成活率。
 */
export async function applyReplantCompletion(replantId: string): Promise<void> {
  await db.transaction('rw', db.plots, db.replants, db.surveys, db.plantings, async () => {
    const replant = await db.replants.get(replantId);
    if (!replant) return;
    const plot = await db.plots.get(replant.plotId);
    if (!plot) return;

    const nextMissing = Math.max(0, plot.missingCount - replant.missingCount);
    await db.plots.update(plot.id, {
      missingCount: nextMissing,
      lastReplantDate: today(),
      updatedAt: nowIso(),
    });

    const plantings = await db.plantings.where('plotId').equals(plot.id).toArray();
    const total = plantings.reduce((acc, item) => acc + item.count, 0);
    const surveys = await db.surveys.where('plotId').equals(plot.id).toArray();
    if (surveys.length === 0) return;
    const latest = surveys.reduce((acc, item) => (item.round > acc.round ? item : acc));
    // 补植后按「原成活株数 + 本次补植株数」重新计算成活率
    const aliveAfter = latest.aliveCount + replant.missingCount;
    const rate = total > 0 ? Math.round(Math.min(100, (aliveAfter / total) * 100) * 10) / 10 : latest.survivalRate;
    await db.surveys.update(latest.id, {
      aliveCount: aliveAfter,
      survivalRate: rate,
      grade: latest.gradeManual ? latest.grade : rateLevel(rate),
      updatedAt: nowIso(),
    });
  });
}

/** 推进补植状态（待补植 → 已补植 → 已复核），推进到「已补植」时触发回写 */
export async function advanceReplantState(replantId: string, next: ReplantState): Promise<void> {
  // 硬防线：地块处于挂起 / 只读 / 分宗母块 / 无宗地时，禁止推进补植（挂起期间不出补植计划）
  if (next !== '已复核') {
    const replant = await db.replants.get(replantId);
    if (replant !== undefined) {
      const [plot, parcels, links] = await Promise.all([
        db.plots.get(replant.plotId),
        db.parcels.toArray(),
        db.parcelLinks.toArray(),
      ]);
      if (plot !== undefined && replantBlockReason(plot, parcels, links) !== null) return;
    }
  }
  await db.replants.update(replantId, { state: next, updatedAt: nowIso() });
  if (next === '已补植') {
    await applyReplantCompletion(replantId);
  }
}

/* ---------------------------- 整库快照 ---------------------------- */

export interface DatabaseSnapshot {
  name: string;
  schemaVersion: number;
  exportedAt: string;
  plots: Plot[];
  seedlings: Seedling[];
  plantings: Planting[];
  surveys: Survey[];
  replants: Replant[];
  /** v3 起导出；v2 老存档缺这两项，导入时按原地块编号回填历史宗地 */
  parcels?: Parcel[];
  parcelLinks?: ParcelLink[];
}

/** 导出整库快照 */
export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [plots, seedlings, plantings, surveys, replants, parcels, parcelLinks] = await Promise.all([
    db.plots.toArray(),
    db.seedlings.toArray(),
    db.plantings.toArray(),
    db.surveys.toArray(),
    db.replants.toArray(),
    db.parcels.toArray(),
    db.parcelLinks.toArray(),
  ]);
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    plots,
    seedlings,
    plantings,
    surveys,
    replants,
    parcels,
    parcelLinks,
  };
}

/** 用快照覆盖整库（导入存档）；v2 老存档没有宗地归属时按原地块编号回填，回填不出的只读保留 */
export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [db.plots, db.seedlings, db.plantings, db.surveys, db.replants, db.parcels, db.parcelLinks],
    async () => {
      await Promise.all([
        db.plots.clear(),
        db.seedlings.clear(),
        db.plantings.clear(),
        db.surveys.clear(),
        db.replants.clear(),
        db.parcels.clear(),
        db.parcelLinks.clear(),
      ]);
      await db.plots.bulkPut(snapshot.plots.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.seedlings.bulkPut(snapshot.seedlings.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.plantings.bulkPut(snapshot.plantings.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.surveys.bulkPut(snapshot.surveys.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.replants.bulkPut(snapshot.replants.map((row) => ({ ...row, revision: ROW_REVISION })));

      const parcelRows = snapshot.parcels ?? [];
      const linkRows = snapshot.parcelLinks ?? [];
      if (parcelRows.length > 0) {
        await db.parcels.bulkPut(parcelRows.map((row) => ({ ...row, revision: ROW_REVISION })));
      }
      if (linkRows.length > 0) {
        await db.parcelLinks.bulkPut(linkRows.map((row) => ({ ...row, revision: ROW_REVISION })));
      }
      // 老存档（或残缺存档）没有宗地归属：按原地块编号回填历史宗地，回填不出的置只读
      if (parcelRows.length === 0 && snapshot.plots.length > 0) {
        await backfillHistoricParcels({ plots: db.plots, parcels: db.parcels, parcelLinks: db.parcelLinks });
      }
    },
  );
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.plots, db.seedlings, db.plantings, db.surveys, db.replants, db.parcels, db.parcelLinks],
    async () => {
      await Promise.all([
        db.plots.clear(),
        db.seedlings.clear(),
        db.plantings.clear(),
        db.surveys.clear(),
        db.replants.clear(),
        db.parcels.clear(),
        db.parcelLinks.clear(),
      ]);
    },
  );
  await seedDatabase();
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [plots, seedlings, plantings, surveys, replants, parcels, parcelLinks] = await Promise.all([
    db.plots.count(),
    db.seedlings.count(),
    db.plantings.count(),
    db.surveys.count(),
    db.replants.count(),
    db.parcels.count(),
    db.parcelLinks.count(),
  ]);
  return { plots, seedlings, plantings, surveys, replants, parcels, parcelLinks };
}
