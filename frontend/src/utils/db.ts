/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbmangrove
 * - 含数据结构版本号与 v1 → v2 升级迁移逻辑（升级时按 version().stores() 补齐索引）
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
import type { ParcelAdjustment } from '../types/parcelAdjustment';
import { rateLevel } from './rate';
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
  /** 林业站权属台账：宗地编号 / 权属面积 / 四至 */
  parcels!: Table<Parcel, string>;
  /** 宗地重划（并宗 / 分宗）接账记录 */
  parcelAdjustments!: Table<ParcelAdjustment, string>;

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

    // ---------- v3：接入林业站权属台账（宗地 + 并宗/分宗重划） ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        plots:
          'id, name, tideZone, substrate, restoreMode, state, createdAt, updatedAt, parcelCode, lineageRole',
        seedlings: 'id, plotId, species, source, arrivalDate, quantity',
        plantings: 'id, plotId, seedlingId, plantDate, spacingM',
        surveys: 'id, plotId, [plotId+round], date, grade',
        replants: 'id, plotId, planDate, state, species',
        // 宗地：parcelCode 唯一、按权属状态与编号检索
        parcels: 'id, parcelCode, status, source, areaMu',
        // 重划记录：按方式 / 挂账状态 / 生效日检索
        parcelAdjustments: 'id, mode, linkState, effectiveDate, [mode+linkState]',
      })
      .upgrade(async (tx) => {
        const stamp = nowIso();

        // 迁移 1：既有修复地块补齐宗地对接字段。
        // 老地块此前没有任何宗地归属，按「原地块编号回填历史宗地」（见下），
        // 因此这里全部置为常规角色、非只读；回填不出的个别地块才置只读保留。
        const plotRows = await tx.table('plots').toArray() as Array<Record<string, unknown>>;
        const backfillCodes = new Set<string>();
        for (const row of plotRows) {
          if (typeof row.lineageRole !== 'string') row.lineageRole = 'normal';
          if (typeof row.readOnly !== 'boolean') row.readOnly = false;
          if (typeof row.parcelCode !== 'string') {
            // 原地块编号即作为历史宗地编号回填；空 id 无法回填，留空并置只读
            const legacyCode = typeof row.id === 'string' && row.id.trim() !== '' ? row.id : '';
            row.parcelCode = legacyCode;
            if (legacyCode === '') {
              row.readOnly = true;
            } else {
              backfillCodes.add(legacyCode);
            }
          } else if ((row.parcelCode as string) !== '') {
            backfillCodes.add(row.parcelCode as string);
          }
          row.revision = ROW_REVISION;
          row.updatedAt = stamp;
          await tx.table('plots').put(row);
        }

        // 迁移 2：为每个回填宗地编号补一条「历史宗地」权属台账。
        // 权属面积直接采用对应老地块面积（当时唯一可得的面积口径）；
        // 四至无历史记录可考，留空待林业站补登。回填不出的不造宗地（地块只读保留）。
        const existingParcelCodes = new Set(
          ((await tx.table('parcels').toArray()) as Array<Record<string, unknown>>)
            .map((row) => row.parcelCode)
            .filter((code): code is string => typeof code === 'string'),
        );
        const legacyParcels: Record<string, unknown>[] = [];
        for (const code of backfillCodes) {
          if (existingParcelCodes.has(code)) continue;
          const plot = plotRows.find((row) => row.parcelCode === code);
          legacyParcels.push({
            id: `parcel-legacy-${code}`,
            parcelCode: code,
            areaMu: typeof plot?.areaMu === 'number' ? plot.areaMu : 0,
            boundaries: { east: '', south: '', west: '', north: '' },
            status: 'active',
            source: 'legacyBackfill',
            createdAt: stamp,
            updatedAt: stamp,
            revision: ROW_REVISION,
          });
        }
        if (legacyParcels.length > 0) await tx.table('parcels').bulkPut(legacyParcels);

        // 其余既有行统一抬到新行修订号
        for (const tableName of ['seedlings', 'plantings', 'surveys', 'replants'] as const) {
          await tx.table(tableName).toCollection().modify((row: Record<string, unknown>) => {
            row.revision = ROW_REVISION;
          });
        }
      });
  }
}

export const db = new MangroveDatabase();

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

/** 删除地块并级联清理其下苗木批次、栽植、验收与补植计划。
 * 注意：不删除林业站宗地与重划记录——它们是权属台账，独立于项目部地块存续。 */
export async function removePlot(id: string): Promise<void> {
  await db.transaction('rw', db.plots, db.seedlings, db.plantings, db.surveys, db.replants, async () => {
    await db.seedlings.where('plotId').equals(id).delete();
    await db.plantings.where('plotId').equals(id).delete();
    await db.surveys.where('plotId').equals(id).delete();
    await db.replants.where('plotId').equals(id).delete();
    await db.plots.delete(id);
  });
}

/* -------------------------------- 宗地 -------------------------------- */

export async function listParcels(): Promise<Parcel[]> {
  const rows = await db.parcels.toArray();
  return rows.sort((a, b) => a.parcelCode.localeCompare(b.parcelCode, 'zh-Hans-CN'));
}

export async function getParcelByCode(parcelCode: string): Promise<Parcel | undefined> {
  return db.parcels.where('parcelCode').equals(parcelCode).first();
}

export async function putParcel(row: Parcel): Promise<void> {
  await db.parcels.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removeParcel(id: string): Promise<void> {
  await db.parcels.delete(id);
}

/* ------------------------------ 宗地重划 ------------------------------ */

export async function listParcelAdjustments(): Promise<ParcelAdjustment[]> {
  const rows = await db.parcelAdjustments.toArray();
  return rows.sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate));
}

export async function putParcelAdjustment(row: ParcelAdjustment): Promise<void> {
  await db.parcelAdjustments.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removeParcelAdjustment(id: string): Promise<void> {
  await db.parcelAdjustments.delete(id);
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
  parcels: Parcel[];
  parcelAdjustments: ParcelAdjustment[];
}

/** 导出整库快照 */
export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [plots, seedlings, plantings, surveys, replants, parcels, parcelAdjustments] = await Promise.all([
    db.plots.toArray(),
    db.seedlings.toArray(),
    db.plantings.toArray(),
    db.surveys.toArray(),
    db.replants.toArray(),
    db.parcels.toArray(),
    db.parcelAdjustments.toArray(),
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
    parcelAdjustments,
  };
}

/** 用快照覆盖整库（导入存档）。兼容缺少 v3 两表的旧档：缺失时按空集处理 */
export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  const parcels = snapshot.parcels ?? [];
  const parcelAdjustments = snapshot.parcelAdjustments ?? [];
  // Dexie 单事务类型最多 7 张表，这里拆为「业务五表」与「权属两表」两个连续事务
  await db.transaction('rw', db.plots, db.seedlings, db.plantings, db.surveys, db.replants, async () => {
    await Promise.all([
      db.plots.clear(),
      db.seedlings.clear(),
      db.plantings.clear(),
      db.surveys.clear(),
      db.replants.clear(),
    ]);
    await db.plots.bulkPut(snapshot.plots.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.seedlings.bulkPut(snapshot.seedlings.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.plantings.bulkPut(snapshot.plantings.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.surveys.bulkPut(snapshot.surveys.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.replants.bulkPut(snapshot.replants.map((row) => ({ ...row, revision: ROW_REVISION })));
  });
  await db.transaction('rw', db.parcels, db.parcelAdjustments, async () => {
    await Promise.all([db.parcels.clear(), db.parcelAdjustments.clear()]);
    await db.parcels.bulkPut(parcels.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.parcelAdjustments.bulkPut(parcelAdjustments.map((row) => ({ ...row, revision: ROW_REVISION })));
  });
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction('rw', db.plots, db.seedlings, db.plantings, db.surveys, db.replants, async () => {
    await Promise.all([
      db.plots.clear(),
      db.seedlings.clear(),
      db.plantings.clear(),
      db.surveys.clear(),
      db.replants.clear(),
    ]);
  });
  await db.transaction('rw', db.parcels, db.parcelAdjustments, async () => {
    await Promise.all([db.parcels.clear(), db.parcelAdjustments.clear()]);
  });
  await seedDatabase();
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [plots, seedlings, plantings, surveys, replants, parcels, parcelAdjustments] = await Promise.all([
    db.plots.count(),
    db.seedlings.count(),
    db.plantings.count(),
    db.surveys.count(),
    db.replants.count(),
    db.parcels.count(),
    db.parcelAdjustments.count(),
  ]);
  return { plots, seedlings, plantings, surveys, replants, parcels, parcelAdjustments };
}
