/**
 * 演示数据播种（幂等）
 * 父 → 子 → 孙三层链路：地块 → 苗木批次 / 栽植 → 验收 → 补植；
 * v3 起再挂林业站权属侧：宗地 → 宗地—地块挂接（direct / 并宗 / 分宗 / 挂起复核）。
 * 所有 id 固定，保证 /plots/:id/seedlings、/plots/:id/plantings 深链一定命中真实数据。
 */
import { db, ROW_REVISION } from './db';
import type { Plot } from '../types/plot';
import type { Seedling } from '../types/seedling';
import type { Planting } from '../types/planting';
import type { Survey } from '../types/survey';
import type { Replant } from '../types/replant';
import type { Parcel } from '../types/parcel';
import type { ParcelLink } from '../types/parcelLink';
import { calcSurvivalRate, rateLevel } from './rate';

const SEED_TIME = '2025-01-06T02:00:00.000Z';
/** 分宗重划生效日期：母块历史测次均早于此日期，子块新测次晚于此日期 */
export const SEED_SPLIT_DATE = '2025-06-01';

/** 固定 id，便于文档与深链验证 */
export const SEED_IDS = {
  // 并宗：两老地块（历史编号，栽植 / 验收仍挂老编号）
  plotA: 'plot-donggang-3',
  plotD: 'plot-donggang-4',
  // 一一对应
  plotB: 'plot-xiwan-a',
  // 分宗：母块（历史测次留档）+ 两个班组子块
  plotC: 'plot-beiyu-b',
  plotE: 'plot-beiyu-b-1',
  plotF: 'plot-beiyu-b-2',
} as const;

function plotRow(row: Omit<Plot, 'createdAt' | 'updatedAt' | 'revision'>): Plot {
  return { ...row, createdAt: SEED_TIME, updatedAt: SEED_TIME, revision: ROW_REVISION };
}

function seedlingRow(row: Omit<Seedling, 'createdAt' | 'updatedAt' | 'revision'>): Seedling {
  return { ...row, createdAt: SEED_TIME, updatedAt: SEED_TIME, revision: ROW_REVISION };
}

function plantingRow(row: Omit<Planting, 'createdAt' | 'updatedAt' | 'revision'>): Planting {
  return { ...row, createdAt: SEED_TIME, updatedAt: SEED_TIME, revision: ROW_REVISION };
}

function surveyRow(row: Omit<Survey, 'createdAt' | 'updatedAt' | 'revision' | 'grade' | 'gradeManual' | 'survivalRate'>, total: number): Survey {
  const survivalRate = calcSurvivalRate(row.aliveCount, total);
  return {
    ...row,
    survivalRate,
    grade: rateLevel(survivalRate),
    gradeManual: false,
    createdAt: SEED_TIME,
    updatedAt: SEED_TIME,
    revision: ROW_REVISION,
  };
}

function replantRow(row: Omit<Replant, 'createdAt' | 'updatedAt' | 'revision'>): Replant {
  return { ...row, createdAt: SEED_TIME, updatedAt: SEED_TIME, revision: ROW_REVISION };
}

function parcelRow(row: Omit<Parcel, 'createdAt' | 'updatedAt' | 'revision'>): Parcel {
  return { ...row, createdAt: SEED_TIME, updatedAt: SEED_TIME, revision: ROW_REVISION };
}

function linkRow(row: Omit<ParcelLink, 'createdAt' | 'updatedAt' | 'revision'>): ParcelLink {
  return { ...row, createdAt: SEED_TIME, updatedAt: SEED_TIME, revision: ROW_REVISION };
}

/**
 * 播种演示数据。调用方（initDatabase）已保证仅在主表为空时调用，因此天然幂等；
 * 这里再做一次防御：若已存在地块则直接返回。
 */
export async function seedDatabase(): Promise<void> {
  const exists = await db.plots.count();
  if (exists > 0) return;

  // ---------------- 修复地块（6 块：并宗 2 老块 + 一一对应 1 + 分宗母块 1 + 子块 2） ----------------
  const plots: Plot[] = [
    plotRow({
      id: SEED_IDS.plotA,
      name: '东港南堤 3 号地块',
      areaMu: 46.5,
      tideZone: '中',
      substrate: '淤泥质',
      restoreMode: '造林',
      state: '跟踪中',
      missingCount: 1092,
      lastReplantDate: '',
    }),
    plotRow({
      id: SEED_IDS.plotD,
      name: '东港南堤 4 号地块',
      areaMu: 28.3,
      tideZone: '中',
      substrate: '淤泥质',
      restoreMode: '造林',
      state: '跟踪中',
      missingCount: 0,
      lastReplantDate: '',
    }),
    plotRow({
      id: SEED_IDS.plotB,
      name: '西湾滩涂 A 区',
      areaMu: 32,
      tideZone: '低',
      substrate: '砂泥质',
      restoreMode: '补植',
      state: '跟踪中',
      missingCount: 0,
      lastReplantDate: '2025-04-20',
    }),
    plotRow({
      id: SEED_IDS.plotC,
      name: '北屿外滩 B 区（分宗母块）',
      areaMu: 58.2,
      tideZone: '高',
      substrate: '砂质',
      restoreMode: '造林',
      state: '已验收',
      missingCount: 0,
      lastReplantDate: '2024-11-08',
    }),
    plotRow({
      id: SEED_IDS.plotE,
      name: '北屿外滩 B-1（北屿一班）',
      areaMu: 30,
      tideZone: '高',
      substrate: '砂质',
      restoreMode: '造林',
      state: '跟踪中',
      missingCount: 560,
      lastReplantDate: '',
    }),
    plotRow({
      id: SEED_IDS.plotF,
      name: '北屿外滩 B-2（北屿二班）',
      areaMu: 28.2,
      tideZone: '高',
      substrate: '砂质',
      restoreMode: '造林',
      state: '跟踪中',
      missingCount: 0,
      lastReplantDate: '',
    }),
  ];

  // ---------------- 苗木批次（每地块 1 批） ----------------
  const seedlings: Seedling[] = [
    seedlingRow({ id: 'seedling-a1', plotId: SEED_IDS.plotA, species: '秋茄', source: '自育苗', spec: '50cm 裸根苗', quantity: 5600, arrivalDate: '2024-04-05' }),
    seedlingRow({ id: 'seedling-d1', plotId: SEED_IDS.plotD, species: '桐花树', source: '外购', spec: '40cm 营养袋苗', quantity: 3000, arrivalDate: '2024-04-10' }),
    seedlingRow({ id: 'seedling-b1', plotId: SEED_IDS.plotB, species: '白骨壤', source: '自育苗', spec: '45cm 裸根苗', quantity: 3500, arrivalDate: '2024-04-28' }),
    seedlingRow({ id: 'seedling-c1', plotId: SEED_IDS.plotC, species: '无瓣海桑', source: '外购', spec: '60cm 营养袋苗', quantity: 8300, arrivalDate: '2024-03-12' }),
    seedlingRow({ id: 'seedling-e1', plotId: SEED_IDS.plotE, species: '无瓣海桑', source: '自育苗', spec: '55cm 营养袋苗', quantity: 2600, arrivalDate: '2025-06-08' }),
    seedlingRow({ id: 'seedling-f1', plotId: SEED_IDS.plotF, species: '白骨壤', source: '自育苗', spec: '45cm 裸根苗', quantity: 2300, arrivalDate: '2025-06-08' }),
  ];

  // ---------------- 栽植记录（每地块 1 条） ----------------
  const plantings: Planting[] = [
    plantingRow({ id: 'planting-a1', plotId: SEED_IDS.plotA, seedlingId: 'seedling-a1', plantDate: '2024-04-12', spacingM: 1, count: 5200, operator: '东港一班' }),
    plantingRow({ id: 'planting-d1', plotId: SEED_IDS.plotD, seedlingId: 'seedling-d1', plantDate: '2024-04-15', spacingM: 0.8, count: 2800, operator: '东港二班' }),
    plantingRow({ id: 'planting-b1', plotId: SEED_IDS.plotB, seedlingId: 'seedling-b1', plantDate: '2024-05-06', spacingM: 1.1, count: 3300, operator: '西湾一班' }),
    plantingRow({ id: 'planting-c1', plotId: SEED_IDS.plotC, seedlingId: 'seedling-c1', plantDate: '2024-03-20', spacingM: 1.2, count: 8000, operator: '北屿一班' }),
    plantingRow({ id: 'planting-e1', plotId: SEED_IDS.plotE, seedlingId: 'seedling-e1', plantDate: '2025-06-12', spacingM: 1.2, count: 2400, operator: '北屿一班' }),
    plantingRow({ id: 'planting-f1', plotId: SEED_IDS.plotF, seedlingId: 'seedling-f1', plantDate: '2025-06-12', spacingM: 1.3, count: 2100, operator: '北屿二班' }),
  ];

  // 各地块栽植总株数，用于派生成活率
  const totalByPlot: Record<string, number> = {
    [SEED_IDS.plotA]: 5200,
    [SEED_IDS.plotD]: 2800,
    [SEED_IDS.plotB]: 3300,
    [SEED_IDS.plotC]: 8000,
    [SEED_IDS.plotE]: 2400,
    [SEED_IDS.plotF]: 2100,
  };

  // ---------------- 验收记录 ----------------
  // 并宗两老块：两个同测次（跨宗可相加）
  // 分宗母块：2 个历史测次（早于分宗生效日，留档只读）；子块：分宗后各 1 个新测次
  const surveys: Survey[] = [
    surveyRow({ id: 'survey-a1', plotId: SEED_IDS.plotA, round: 1, date: '2024-06-20', aliveCount: 4680, avgHeightCm: 62 }, totalByPlot[SEED_IDS.plotA]),
    surveyRow({ id: 'survey-a2', plotId: SEED_IDS.plotA, round: 2, date: '2024-09-18', aliveCount: 4420, avgHeightCm: 78 }, totalByPlot[SEED_IDS.plotA]),
    surveyRow({ id: 'survey-d1', plotId: SEED_IDS.plotD, round: 1, date: '2024-06-22', aliveCount: 2576, avgHeightCm: 58 }, totalByPlot[SEED_IDS.plotD]),
    surveyRow({ id: 'survey-d2', plotId: SEED_IDS.plotD, round: 2, date: '2024-09-20', aliveCount: 2408, avgHeightCm: 74 }, totalByPlot[SEED_IDS.plotD]),
    surveyRow({ id: 'survey-b1', plotId: SEED_IDS.plotB, round: 1, date: '2024-07-05', aliveCount: 2772, avgHeightCm: 41 }, totalByPlot[SEED_IDS.plotB]),
    surveyRow({ id: 'survey-b2', plotId: SEED_IDS.plotB, round: 2, date: '2024-10-12', aliveCount: 2805, avgHeightCm: 55 }, totalByPlot[SEED_IDS.plotB]),
    surveyRow({ id: 'survey-c1', plotId: SEED_IDS.plotC, round: 1, date: '2024-05-28', aliveCount: 7680, avgHeightCm: 70 }, totalByPlot[SEED_IDS.plotC]),
    surveyRow({ id: 'survey-c2', plotId: SEED_IDS.plotC, round: 2, date: '2024-08-30', aliveCount: 7440, avgHeightCm: 88 }, totalByPlot[SEED_IDS.plotC]),
    surveyRow({ id: 'survey-e1', plotId: SEED_IDS.plotE, round: 1, date: '2025-09-10', aliveCount: 1848, avgHeightCm: 64 }, totalByPlot[SEED_IDS.plotE]),
    surveyRow({ id: 'survey-f1', plotId: SEED_IDS.plotF, round: 1, date: '2025-09-10', aliveCount: 1932, avgHeightCm: 66 }, totalByPlot[SEED_IDS.plotF]),
  ];

  // ---------------- 补植计划 ----------------
  const replants: Replant[] = [
    replantRow({ id: 'replant-a1', plotId: SEED_IDS.plotA, missingCount: 1092, planDate: '2025-04-10', species: '秋茄', state: '待补植' }),
    replantRow({ id: 'replant-b1', plotId: SEED_IDS.plotB, missingCount: 495, planDate: '2025-04-18', species: '白骨壤', state: '已复核' }),
    replantRow({ id: 'replant-e1', plotId: SEED_IDS.plotE, missingCount: 552, planDate: '2025-10-20', species: '无瓣海桑', state: '待补植' }),
  ];

  // ---------------- 林业站权属宗地 ----------------
  // 并宗宗地：面积 74.8 = 46.5 + 28.3，对得上 → 正常
  // 分宗宗地：面积 58.2 = 30 + 28.2，对得上 → 正常
  // 南洲嘴宗地：面积比挂接地块大 20% → 对不上 → 挂起复核
  const parcels: Parcel[] = [
    parcelRow({
      id: 'parcel-donggang-merged',
      parcelCode: 'LD-DG-2025-017',
      ownerName: '东港镇红树林管护站',
      areaMu: 74.8,
      boundaries: '东：南堤3号闸；南：光滩警戒线；西：4号排水渠；北：海堤内坡脚',
      effectiveDate: '2025-02-01',
      status: '正常',
      holdReason: '',
      source: 'manual',
    }),
    parcelRow({
      id: 'parcel-xiwan-a',
      parcelCode: 'LD-XW-2023-006',
      ownerName: '西湾村经济合作社',
      areaMu: 32,
      boundaries: '东：西湾栈桥；南：低潮线；西：A 区界桩；北：养殖塘排水渠',
      effectiveDate: '2023-06-01',
      status: '正常',
      holdReason: '',
      source: 'manual',
    }),
    parcelRow({
      id: 'parcel-beiyu-split',
      parcelCode: 'LD-BY-2025-031',
      ownerName: '北屿生态修复公司',
      areaMu: 58.2,
      boundaries: '东：北屿灯塔基线；南：中潮沟；西：B 区界桩；北：防风林缘',
      effectiveDate: SEED_SPLIT_DATE,
      status: '正常',
      holdReason: '',
      source: 'manual',
    }),
    parcelRow({
      id: 'parcel-nanzhou-held',
      parcelCode: 'LD-NZ-2025-009',
      ownerName: '南洲嘴管护组',
      areaMu: 38.4,
      boundaries: '东：南洲旧堤；南：低潮线；西：9 号界桩；北：进滩便道',
      effectiveDate: '2025-03-01',
      status: '挂起复核',
      holdReason: '权属面积 38.4 亩与挂接地块面积合计 32 亩偏差 20.0%，超过 2% 容差，待林业站现场复核。',
      source: 'manual',
    }),
  ];

  // ---------------- 宗地—地块挂接关系 ----------------
  const parcelLinks: ParcelLink[] = [
    // 并宗：两老地块作为 merge-source
    linkRow({ id: 'plink-dg-a', parcelId: 'parcel-donggang-merged', plotId: SEED_IDS.plotA, linkType: 'merge-source', team: '', splitAreaMu: 0 }),
    linkRow({ id: 'plink-dg-d', parcelId: 'parcel-donggang-merged', plotId: SEED_IDS.plotD, linkType: 'merge-source', team: '', splitAreaMu: 0 }),
    // 一一对应；南洲嘴宗地先错挂到西湾 A（面积对不上 → 挂起复核）
    linkRow({ id: 'plink-xw-b', parcelId: 'parcel-xiwan-a', plotId: SEED_IDS.plotB, linkType: 'direct', team: '', splitAreaMu: 0 }),
    linkRow({ id: 'plink-nz-b', parcelId: 'parcel-nanzhou-held', plotId: SEED_IDS.plotB, linkType: 'direct', team: '', splitAreaMu: 0 }),
    // 分宗：母块留档 + 两子块各归班组
    linkRow({ id: 'plink-by-c', parcelId: 'parcel-beiyu-split', plotId: SEED_IDS.plotC, linkType: 'split-parent', team: '', splitAreaMu: 0 }),
    linkRow({ id: 'plink-by-e', parcelId: 'parcel-beiyu-split', plotId: SEED_IDS.plotE, linkType: 'split-child', team: '北屿一班', splitAreaMu: 30 }),
    linkRow({ id: 'plink-by-f', parcelId: 'parcel-beiyu-split', plotId: SEED_IDS.plotF, linkType: 'split-child', team: '北屿二班', splitAreaMu: 28.2 }),
  ];

  await db.transaction(
    'rw',
    [db.plots, db.seedlings, db.plantings, db.surveys, db.replants, db.parcels, db.parcelLinks],
    async () => {
      await db.plots.bulkPut(plots);
      await db.seedlings.bulkPut(seedlings);
      await db.plantings.bulkPut(plantings);
      await db.surveys.bulkPut(surveys);
      await db.replants.bulkPut(replants);
      await db.parcels.bulkPut(parcels);
      await db.parcelLinks.bulkPut(parcelLinks);
    },
  );
}
