/**
 * 演示数据播种（幂等）
 * 父 → 子 → 孙三层链路：地块 → 苗木批次 / 栽植 → 验收 → 补植
 * 所有 id 固定，保证 /plots/:id/seedlings、/plots/:id/plantings 深链一定命中真实数据。
 */
import { db, ROW_REVISION } from './db';
import type { Plot } from '../types/plot';
import type { Seedling } from '../types/seedling';
import type { Planting } from '../types/planting';
import type { Survey } from '../types/survey';
import type { Replant } from '../types/replant';
import type { Parcel } from '../types/parcel';
import type { ParcelAdjustment } from '../types/parcelAdjustment';
import { calcSurvivalRate, rateLevel } from './rate';

const SEED_TIME = '2025-01-06T02:00:00.000Z';

/** 固定 id，便于文档与深链验证 */
export const SEED_IDS = {
  plotA: 'plot-donggang-3',
  plotB: 'plot-xiwan-a',
  plotC: 'plot-beiyu-b',
  // —— 并宗演示（两宗并一宗，按栽植株数相加，测次对齐） ——
  mergeOld1: 'plot-nantan-1',
  mergeOld2: 'plot-nantan-2',
  mergeTarget: 'plot-nantan-he',
  // —— 并宗挂起演示（同测次日期对不上，挂起复核） ——
  holdOld1: 'plot-donghai-1',
  holdOld2: 'plot-donghai-2',
  holdTarget: 'plot-donghai-he',
  // —— 分宗演示（一大宗拆两宗，分属两班组，历史测次留老地块只读） ——
  splitParent: 'plot-xisha-old',
  splitChild1: 'plot-xisha-1',
  splitChild2: 'plot-xisha-2',
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

function adjustmentRow(row: Omit<ParcelAdjustment, 'createdAt' | 'updatedAt' | 'revision'>): ParcelAdjustment {
  return { ...row, createdAt: SEED_TIME, updatedAt: SEED_TIME, revision: ROW_REVISION };
}

/** 常规地块的宗地对接字段默认值 */
function normalLinkage(parcelCode: string): Pick<Plot, 'parcelCode' | 'lineageRole' | 'readOnly'> {
  return { parcelCode, lineageRole: 'normal', readOnly: false };
}

/**
 * 播种演示数据。调用方（initDatabase）已保证仅在主表为空时调用，因此天然幂等；
 * 这里再做一次防御：若已存在地块则直接返回。
 */
export async function seedDatabase(): Promise<void> {
  const exists = await db.plots.count();
  if (exists > 0) return;

  // ---------------- 地块（3 块常规 + 并宗/分宗谱系地块） ----------------
  const plots: Plot[] = [
    plotRow({
      id: SEED_IDS.plotA,
      name: '东港南堤 3 号地块',
      areaMu: 46.5,
      tideZone: '中',
      substrate: '淤泥质',
      restoreMode: '造林',
      state: '跟踪中',
      ...normalLinkage(SEED_IDS.plotA),
      missingCount: 1092,
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
      ...normalLinkage(SEED_IDS.plotB),
      missingCount: 0,
      lastReplantDate: '2025-04-20',
    }),
    plotRow({
      id: SEED_IDS.plotC,
      name: '北屿外滩 B 区',
      areaMu: 58.2,
      tideZone: '高',
      substrate: '砂质',
      restoreMode: '造林',
      state: '已验收',
      ...normalLinkage(SEED_IDS.plotC),
      missingCount: 560,
      lastReplantDate: '2024-11-08',
    }),

    // 并宗：南滩 1、2 号老地块 → 南滩合并地块
    plotRow({
      id: SEED_IDS.mergeOld1,
      name: '南滩 1 号老地块',
      areaMu: 20,
      tideZone: '中',
      substrate: '淤泥质',
      restoreMode: '造林',
      state: '跟踪中',
      parcelCode: 'GBM-2024-031',
      lineageRole: 'legacy',
      readOnly: true,
      missingCount: 0,
      lastReplantDate: '',
    }),
    plotRow({
      id: SEED_IDS.mergeOld2,
      name: '南滩 2 号老地块',
      areaMu: 25,
      tideZone: '中',
      substrate: '淤泥质',
      restoreMode: '造林',
      state: '跟踪中',
      parcelCode: 'GBM-2024-032',
      lineageRole: 'legacy',
      readOnly: true,
      missingCount: 0,
      lastReplantDate: '',
    }),
    plotRow({
      id: SEED_IDS.mergeTarget,
      name: '南滩并宗地（31+32）',
      areaMu: 45,
      tideZone: '中',
      substrate: '淤泥质',
      restoreMode: '造林',
      state: '跟踪中',
      parcelCode: 'GBM-2025-101',
      lineageRole: 'mergeTarget',
      readOnly: false,
      missingCount: 0,
      lastReplantDate: '',
    }),

    // 并宗挂起：东海 1、2 号老地块第 2 测次验收日期对不上
    plotRow({
      id: SEED_IDS.holdOld1,
      name: '东海 1 号老地块',
      areaMu: 15,
      tideZone: '低',
      substrate: '砂泥质',
      restoreMode: '造林',
      state: '跟踪中',
      parcelCode: 'GBM-2024-041',
      lineageRole: 'legacy',
      readOnly: true,
      missingCount: 0,
      lastReplantDate: '',
    }),
    plotRow({
      id: SEED_IDS.holdOld2,
      name: '东海 2 号老地块',
      areaMu: 18,
      tideZone: '低',
      substrate: '砂泥质',
      restoreMode: '造林',
      state: '跟踪中',
      parcelCode: 'GBM-2024-042',
      lineageRole: 'legacy',
      readOnly: true,
      missingCount: 0,
      lastReplantDate: '',
    }),
    plotRow({
      id: SEED_IDS.holdTarget,
      name: '东海并宗地（41+42）',
      areaMu: 33,
      tideZone: '低',
      substrate: '砂泥质',
      restoreMode: '造林',
      state: '跟踪中',
      parcelCode: 'GBM-2025-102',
      lineageRole: 'mergeTarget',
      readOnly: false,
      missingCount: 0,
      lastReplantDate: '',
    }),

    // 分宗：西沙老地块 → 西沙一区（一班）、西沙二区（二班）
    plotRow({
      id: SEED_IDS.splitParent,
      name: '西沙老地块（分宗前）',
      areaMu: 60,
      tideZone: '高',
      substrate: '砂质',
      restoreMode: '造林',
      state: '跟踪中',
      parcelCode: 'GBM-2024-050',
      lineageRole: 'legacy',
      readOnly: true,
      missingCount: 0,
      lastReplantDate: '',
    }),
    plotRow({
      id: SEED_IDS.splitChild1,
      name: '西沙一区（一班）',
      areaMu: 30,
      tideZone: '高',
      substrate: '砂质',
      restoreMode: '造林',
      state: '跟踪中',
      parcelCode: 'GBM-2025-201',
      lineageRole: 'splitChild',
      readOnly: false,
      missingCount: 0,
      lastReplantDate: '',
    }),
    plotRow({
      id: SEED_IDS.splitChild2,
      name: '西沙二区（二班）',
      areaMu: 30,
      tideZone: '高',
      substrate: '砂质',
      restoreMode: '造林',
      state: '跟踪中',
      parcelCode: 'GBM-2025-202',
      lineageRole: 'splitChild',
      readOnly: false,
      missingCount: 0,
      lastReplantDate: '',
    }),
  ];

  // ---------------- 苗木批次（每地块 2 批） ----------------
  const seedlings: Seedling[] = [
    seedlingRow({ id: 'seedling-a1', plotId: SEED_IDS.plotA, species: '秋茄', source: '自育苗', spec: '50cm 裸根苗', quantity: 3200, arrivalDate: '2024-04-05' }),
    seedlingRow({ id: 'seedling-a2', plotId: SEED_IDS.plotA, species: '桐花树', source: '外购', spec: '40cm 营养袋苗', quantity: 2400, arrivalDate: '2024-04-10' }),
    seedlingRow({ id: 'seedling-b1', plotId: SEED_IDS.plotB, species: '白骨壤', source: '自育苗', spec: '45cm 裸根苗', quantity: 1900, arrivalDate: '2024-04-28' }),
    seedlingRow({ id: 'seedling-b2', plotId: SEED_IDS.plotB, species: '秋茄', source: '外购', spec: '50cm 营养袋苗', quantity: 1600, arrivalDate: '2024-05-02' }),
    seedlingRow({ id: 'seedling-c1', plotId: SEED_IDS.plotC, species: '无瓣海桑', source: '外购', spec: '60cm 营养袋苗', quantity: 4400, arrivalDate: '2024-03-12' }),
    seedlingRow({ id: 'seedling-c2', plotId: SEED_IDS.plotC, species: '白骨壤', source: '自育苗', spec: '45cm 裸根苗', quantity: 3900, arrivalDate: '2024-03-16' }),
  ];

  // ---------------- 栽植记录（每地块 2 条，引用真实苗木批次） ----------------
  const plantings: Planting[] = [
    plantingRow({ id: 'planting-a1', plotId: SEED_IDS.plotA, seedlingId: 'seedling-a1', plantDate: '2024-04-12', spacingM: 1, count: 3000, operator: '东港一班' }),
    plantingRow({ id: 'planting-a2', plotId: SEED_IDS.plotA, seedlingId: 'seedling-a2', plantDate: '2024-04-15', spacingM: 0.8, count: 2200, operator: '东港二班' }),
    plantingRow({ id: 'planting-b1', plotId: SEED_IDS.plotB, seedlingId: 'seedling-b1', plantDate: '2024-05-06', spacingM: 1.2, count: 1800, operator: '西湾一班' }),
    plantingRow({ id: 'planting-b2', plotId: SEED_IDS.plotB, seedlingId: 'seedling-b2', plantDate: '2024-05-09', spacingM: 1, count: 1500, operator: '西湾二班' }),
    plantingRow({ id: 'planting-c1', plotId: SEED_IDS.plotC, seedlingId: 'seedling-c1', plantDate: '2024-03-20', spacingM: 1.5, count: 4200, operator: '北屿一班' }),
    plantingRow({ id: 'planting-c2', plotId: SEED_IDS.plotC, seedlingId: 'seedling-c2', plantDate: '2024-03-24', spacingM: 1.2, count: 3800, operator: '北屿二班' }),

    // 并宗（南滩）：老 1 号 2000 株、老 2 号 2600 株 → 分母 4600
    plantingRow({ id: 'planting-nantan-1', plotId: SEED_IDS.mergeOld1, seedlingId: 'seedling-a1', plantDate: '2024-04-12', spacingM: 1.1, count: 2000, operator: '南滩一班' }),
    plantingRow({ id: 'planting-nantan-2', plotId: SEED_IDS.mergeOld2, seedlingId: 'seedling-a2', plantDate: '2024-04-14', spacingM: 1, count: 2600, operator: '南滩二班' }),
    // 并宗挂起（东海）：老 1 号 1200、老 2 号 1500
    plantingRow({ id: 'planting-donghai-1', plotId: SEED_IDS.holdOld1, seedlingId: 'seedling-b1', plantDate: '2024-05-06', spacingM: 1.2, count: 1200, operator: '东海一班' }),
    plantingRow({ id: 'planting-donghai-2', plotId: SEED_IDS.holdOld2, seedlingId: 'seedling-b2', plantDate: '2024-05-08', spacingM: 1.2, count: 1500, operator: '东海二班' }),
    // 分宗（西沙）：分宗前栽植全部留在老地块（历史只读），新地块生效后另行栽植
    plantingRow({ id: 'planting-xisha-old', plotId: SEED_IDS.splitParent, seedlingId: 'seedling-c1', plantDate: '2024-03-20', spacingM: 1.4, count: 6000, operator: '西沙联合班' }),
    plantingRow({ id: 'planting-xisha-1', plotId: SEED_IDS.splitChild1, seedlingId: 'seedling-c1', plantDate: '2025-05-10', spacingM: 1.2, count: 1800, operator: '西沙一班' }),
    plantingRow({ id: 'planting-xisha-2', plotId: SEED_IDS.splitChild2, seedlingId: 'seedling-c2', plantDate: '2025-05-12', spacingM: 1.2, count: 1700, operator: '西沙二班' }),
  ];

  // 各地块栽植总株数，用于派生成活率
  const totalByPlot: Record<string, number> = {
    [SEED_IDS.plotA]: 5200,
    [SEED_IDS.plotB]: 3300,
    [SEED_IDS.plotC]: 8000,
  };

  // ---------------- 验收记录（每地块 2–3 个测次） ----------------
  const surveys: Survey[] = [
    surveyRow({ id: 'survey-a1', plotId: SEED_IDS.plotA, round: 1, date: '2024-06-20', aliveCount: 4680, avgHeightCm: 62 }, totalByPlot[SEED_IDS.plotA]),
    surveyRow({ id: 'survey-a2', plotId: SEED_IDS.plotA, round: 2, date: '2024-09-18', aliveCount: 4420, avgHeightCm: 78 }, totalByPlot[SEED_IDS.plotA]),
    surveyRow({ id: 'survey-a3', plotId: SEED_IDS.plotA, round: 3, date: '2025-03-15', aliveCount: 4108, avgHeightCm: 96 }, totalByPlot[SEED_IDS.plotA]),
    surveyRow({ id: 'survey-b1', plotId: SEED_IDS.plotB, round: 1, date: '2024-07-05', aliveCount: 2772, avgHeightCm: 41 }, totalByPlot[SEED_IDS.plotB]),
    surveyRow({ id: 'survey-b2', plotId: SEED_IDS.plotB, round: 2, date: '2024-10-12', aliveCount: 2112, avgHeightCm: 55 }, totalByPlot[SEED_IDS.plotB]),
    surveyRow({ id: 'survey-c1', plotId: SEED_IDS.plotC, round: 1, date: '2024-05-28', aliveCount: 7680, avgHeightCm: 70 }, totalByPlot[SEED_IDS.plotC]),
    surveyRow({ id: 'survey-c2', plotId: SEED_IDS.plotC, round: 2, date: '2024-08-30', aliveCount: 7440, avgHeightCm: 88 }, totalByPlot[SEED_IDS.plotC]),

    // 并宗（南滩）：两老地块同测次、同验收日期，可对齐
    surveyRow({ id: 'survey-nantan-1-r1', plotId: SEED_IDS.mergeOld1, round: 1, date: '2024-07-10', aliveCount: 1840, avgHeightCm: 48 }, 2000),
    surveyRow({ id: 'survey-nantan-2-r1', plotId: SEED_IDS.mergeOld2, round: 1, date: '2024-07-10', aliveCount: 2340, avgHeightCm: 46 }, 2600),
    surveyRow({ id: 'survey-nantan-1-r2', plotId: SEED_IDS.mergeOld1, round: 2, date: '2024-10-15', aliveCount: 1700, avgHeightCm: 64 }, 2000),
    surveyRow({ id: 'survey-nantan-2-r2', plotId: SEED_IDS.mergeOld2, round: 2, date: '2024-10-15', aliveCount: 2160, avgHeightCm: 62 }, 2600),

    // 并宗挂起（东海）：第 1 测次日期一致可对齐，第 2 测次日期不一致 → roundMisaligned 挂起
    surveyRow({ id: 'survey-donghai-1-r1', plotId: SEED_IDS.holdOld1, round: 1, date: '2024-08-01', aliveCount: 1080, avgHeightCm: 40 }, 1200),
    surveyRow({ id: 'survey-donghai-2-r1', plotId: SEED_IDS.holdOld2, round: 1, date: '2024-08-01', aliveCount: 1320, avgHeightCm: 42 }, 1500),
    surveyRow({ id: 'survey-donghai-1-r2', plotId: SEED_IDS.holdOld1, round: 2, date: '2024-11-02', aliveCount: 960, avgHeightCm: 58 }, 1200),
    surveyRow({ id: 'survey-donghai-2-r2', plotId: SEED_IDS.holdOld2, round: 2, date: '2024-11-20', aliveCount: 1170, avgHeightCm: 60 }, 1500),

    // 分宗（西沙）：分宗前的历史测次只挂在老地块（只读），不划归新区
    surveyRow({ id: 'survey-xisha-old-r1', plotId: SEED_IDS.splitParent, round: 1, date: '2024-06-10', aliveCount: 5400, avgHeightCm: 66 }, 6000),
    surveyRow({ id: 'survey-xisha-old-r2', plotId: SEED_IDS.splitParent, round: 2, date: '2024-09-12', aliveCount: 5100, avgHeightCm: 82 }, 6000),
    // 分宗生效后新地块各自从第 1 测次重新起测
    surveyRow({ id: 'survey-xisha-1-r1', plotId: SEED_IDS.splitChild1, round: 1, date: '2025-08-15', aliveCount: 1620, avgHeightCm: 44 }, 1800),
    surveyRow({ id: 'survey-xisha-2-r1', plotId: SEED_IDS.splitChild2, round: 1, date: '2025-08-15', aliveCount: 1500, avgHeightCm: 42 }, 1700),
  ];

  // ---------------- 补植计划（每常规地块 1 条，覆盖三种状态） ----------------
  const replants: Replant[] = [
    replantRow({ id: 'replant-a1', plotId: SEED_IDS.plotA, missingCount: 1092, planDate: '2025-04-10', species: '秋茄', state: '待补植' }),
    replantRow({ id: 'replant-b1', plotId: SEED_IDS.plotB, missingCount: 1188, planDate: '2025-04-18', species: '白骨壤', state: '已补植' }),
    replantRow({ id: 'replant-c1', plotId: SEED_IDS.plotC, missingCount: 560, planDate: '2024-11-05', species: '无瓣海桑', state: '已复核' }),
  ];

  // ---------------- 林业站权属台账：宗地 ----------------
  const parcels: Parcel[] = [
    // 三块常规地块的历史回填宗地（id 与地块一致，由升级回填逻辑同款规则产生）
    parcelRow({
      id: `parcel-legacy-${SEED_IDS.plotA}`,
      parcelCode: SEED_IDS.plotA,
      areaMu: 46.5,
      boundaries: { east: '', south: '', west: '', north: '' },
      status: 'active',
      source: 'legacyBackfill',
    }),
    parcelRow({
      id: `parcel-legacy-${SEED_IDS.plotB}`,
      parcelCode: SEED_IDS.plotB,
      areaMu: 32,
      boundaries: { east: '', south: '', west: '', north: '' },
      status: 'active',
      source: 'legacyBackfill',
    }),
    parcelRow({
      id: `parcel-legacy-${SEED_IDS.plotC}`,
      parcelCode: SEED_IDS.plotC,
      areaMu: 58.2,
      boundaries: { east: '', south: '', west: '', north: '' },
      status: 'active',
      source: 'legacyBackfill',
    }),

    // 并宗（南滩）老两宗（历史）+ 新宗（现行）
    parcelRow({ id: 'parcel-gbm-031', parcelCode: 'GBM-2024-031', areaMu: 20, boundaries: { east: '中心沟', south: '南滩堤', west: '1 号界桩', north: '横排沟' }, status: 'history', source: 'forestry' }),
    parcelRow({ id: 'parcel-gbm-032', parcelCode: 'GBM-2024-032', areaMu: 25, boundaries: { east: '2 号界桩', south: '南滩堤', west: '中心沟', north: '横排沟' }, status: 'history', source: 'forestry' }),
    parcelRow({ id: 'parcel-gbm-101', parcelCode: 'GBM-2025-101', areaMu: 45, boundaries: { east: '2 号界桩', south: '南滩堤', west: '1 号界桩', north: '横排沟' }, status: 'active', source: 'forestry' }),

    // 并宗挂起（东海）
    parcelRow({ id: 'parcel-gbm-041', parcelCode: 'GBM-2024-041', areaMu: 15, boundaries: { east: '东海闸', south: '防潮堤', west: '冲沟', north: '旱季水位线' }, status: 'history', source: 'forestry' }),
    parcelRow({ id: 'parcel-gbm-042', parcelCode: 'GBM-2024-042', areaMu: 18, boundaries: { east: '东礁石', south: '防潮堤', west: '东海闸', north: '旱季水位线' }, status: 'history', source: 'forestry' }),
    parcelRow({ id: 'parcel-gbm-102', parcelCode: 'GBM-2025-102', areaMu: 33, boundaries: { east: '东礁石', south: '防潮堤', west: '冲沟', north: '旱季水位线' }, status: 'active', source: 'forestry' }),

    // 分宗（西沙）老宗（历史）+ 两新宗（现行，分属两班组）
    parcelRow({ id: 'parcel-gbm-050', parcelCode: 'GBM-2024-050', areaMu: 60, boundaries: { east: '西沙东界', south: '西沙南滩', west: '西沙西港', north: '护岸林' }, status: 'history', source: 'forestry' }),
    parcelRow({ id: 'parcel-gbm-201', parcelCode: 'GBM-2025-201', areaMu: 30, boundaries: { east: '分界中线', south: '西沙南滩', west: '西沙西港', north: '护岸林' }, status: 'active', source: 'forestry' }),
    parcelRow({ id: 'parcel-gbm-202', parcelCode: 'GBM-2025-202', areaMu: 30, boundaries: { east: '西沙东界', south: '西沙南滩', west: '分界中线', north: '护岸林' }, status: 'active', source: 'forestry' }),
  ];

  // ---------------- 宗地重划记录（并宗 / 分宗） ----------------
  const parcelAdjustments: ParcelAdjustment[] = [
    adjustmentRow({
      id: 'adj-nantan-merge',
      mode: 'merge',
      oldParcelCodes: ['GBM-2024-031', 'GBM-2024-032'],
      newParcelCodes: ['GBM-2025-101'],
      parentPlotIds: [SEED_IDS.mergeOld1, SEED_IDS.mergeOld2],
      successorPlotIds: [SEED_IDS.mergeTarget],
      effectiveDate: '2025-01-10',
      linkState: 'linked',
      holdReason: 'none',
      heldRounds: [],
      remark: '南滩相邻两宗并为一宗；分母按两老地块栽植总株数 4600 株相加。',
    }),
    adjustmentRow({
      id: 'adj-donghai-merge',
      mode: 'merge',
      oldParcelCodes: ['GBM-2024-041', 'GBM-2024-042'],
      newParcelCodes: ['GBM-2025-102'],
      parentPlotIds: [SEED_IDS.holdOld1, SEED_IDS.holdOld2],
      successorPlotIds: [SEED_IDS.holdTarget],
      effectiveDate: '2025-01-12',
      linkState: 'hold',
      holdReason: 'roundMisaligned',
      heldRounds: [2],
      remark: '第 2 测次两老地块验收日期（11-02 / 11-20）对不上，挂起复核，期间不出补植计划。',
    }),
    adjustmentRow({
      id: 'adj-xisha-split',
      mode: 'split',
      oldParcelCodes: ['GBM-2024-050'],
      newParcelCodes: ['GBM-2025-201', 'GBM-2025-202'],
      parentPlotIds: [SEED_IDS.splitParent],
      successorPlotIds: [SEED_IDS.splitChild1, SEED_IDS.splitChild2],
      effectiveDate: '2025-05-01',
      linkState: 'linked',
      holdReason: 'none',
      heldRounds: [],
      remark: '一大宗拆两宗分属西沙一班/二班；分宗前历史测次保留在老地块只读，新区各自重新起测。',
    }),
  ];

  await db.transaction('rw', db.plots, db.seedlings, db.plantings, db.surveys, db.replants, async () => {
    await db.plots.bulkPut(plots);
    await db.seedlings.bulkPut(seedlings);
    await db.plantings.bulkPut(plantings);
    await db.surveys.bulkPut(surveys);
    await db.replants.bulkPut(replants);
  });
  await db.transaction('rw', db.parcels, db.parcelAdjustments, async () => {
    await db.parcels.bulkPut(parcels);
    await db.parcelAdjustments.bulkPut(parcelAdjustments);
  });
}
