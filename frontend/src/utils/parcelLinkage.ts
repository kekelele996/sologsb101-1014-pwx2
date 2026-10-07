/**
 * 宗地（林业站权属台账）与修复地块（项目部）接账的纯逻辑层。
 * 全部为无副作用纯函数，便于单测与在 store / 页面复用。
 *
 * 两条关键口径（决策见 docs/parcel-linkage.md）：
 *   1) 并宗成活率分母 —— 按各老地块「栽植总株数直接相加」，不按权属面积加权。
 *      理由：成活率 = 成活株数 / 栽植株数，株数是可加的物理量；面积加权会把
 *      不同立地、不同实际栽植密度混进分母，成活率不再是真实存活比例。
 *      成活株数按「同测次 + 同验收日期」对齐后相加；对不上的测次挂起复核。
 *   2) 分宗历史验收测次 —— 分宗前的测次是在整块老地上做的整体抽样，无法物理切分，
 *      一律保留在老地块名下只读，不划归任一新地块；新地块自生效日各自重新起测。
 */
import type { Plot } from '../types/plot';
import type { Survey } from '../types/survey';
import type { Planting } from '../types/planting';
import type { Parcel } from '../types/parcel';
import type {
  AdjustmentMode,
  HoldReason,
  ParcelAdjustment,
} from '../types/parcelAdjustment';
import { PARCEL_AREA_TOLERANCE } from '../types/parcelAdjustment';
import type { SurvivalSummary, SurvivalPoint } from '../hooks/useSurvivalRate';
import { buildSurvivalSummary } from '../hooks/useSurvivalRate';
import { calcSurvivalRate, rateLevel, round1, suggestReplantCount, SURVIVAL_WARN_RATE } from './rate';

/* ------------------------------ 基础选择器 ------------------------------ */

/** 找某地块作为「承接方（successor）」参与的那条重划记录 */
export function findSuccessorAdjustment(
  plotId: string,
  adjustments: ParcelAdjustment[],
): ParcelAdjustment | undefined {
  return adjustments.find((adj) => adj.successorPlotIds.includes(plotId));
}

/** 找某地块作为「老地块（parent）」被替代的那条重划记录 */
export function findParentAdjustment(
  plotId: string,
  adjustments: ParcelAdjustment[],
): ParcelAdjustment | undefined {
  return adjustments.find((adj) => adj.parentPlotIds.includes(plotId));
}

export function adjustmentByNewParcel(
  parcelCode: string,
  adjustments: ParcelAdjustment[],
): ParcelAdjustment | undefined {
  return adjustments.find((adj) => adj.newParcelCodes.includes(parcelCode));
}

/* ------------------------------ 接平校验 ------------------------------ */

export interface AdjustmentCheckResult {
  linkState: ParcelAdjustment['linkState'];
  holdReason: HoldReason;
  heldRounds: number[];
}

function parcelArea(codes: string[], parcels: Parcel[]): number {
  return codes.reduce((acc, code) => {
    const parcel = parcels.find((item) => item.parcelCode === code);
    return acc + (parcel ? parcel.areaMu : 0);
  }, 0);
}

function hasAllParcels(codes: string[], parcels: Parcel[]): boolean {
  return codes.every((code) => parcels.some((item) => item.parcelCode === code));
}

/**
 * 并宗测次对齐：同测次必须在每个老地块各有一条、且验收日期一致，才算接平。
 * 任一老地块缺该测次，或同测次日期不一致，则该测次挂起（roundMisaligned）。
 */
export function mergeAlignedRounds(
  parentPlotIds: string[],
  surveys: Survey[],
): { points: Array<{ round: number; date: string; aligned: boolean; aliveCount: number; surveyIds: string[]; avgHeightCm: number }>; heldRounds: number[] } {
  const byPlot = parentPlotIds.map((plotId) =>
    surveys.filter((row) => row.plotId === plotId),
  );
  const allRounds = Array.from(
    new Set(byPlot.flat().map((row) => row.round)),
  ).sort((a, b) => a - b);

  const points: Array<{ round: number; date: string; aligned: boolean; aliveCount: number; surveyIds: string[]; avgHeightCm: number }> = [];
  const heldRounds: number[] = [];

  for (const round of allRounds) {
    const perPlot = byPlot.map((list) => list.filter((row) => row.round === round));
    const eachOne = perPlot.every((list) => list.length === 1);
    const dates = perPlot.map((list) => list[0]?.date ?? '');
    const sameDate = eachOne && dates.every((date) => date !== '' && date === dates[0]);
    const aligned = eachOne && sameDate;
    const rows = perPlot.map((list) => list[0]).filter((row): row is Survey => row !== undefined);
    const aliveCount = rows.reduce((acc, row) => acc + row.aliveCount, 0);
    // 株高按成活株数加权，避免简单平均被小样本地块带偏
    const heightDenominator = rows.reduce((acc, row) => acc + row.aliveCount, 0);
    const avgHeightCm =
      heightDenominator > 0
        ? round1(rows.reduce((acc, row) => acc + row.avgHeightCm * row.aliveCount, 0) / heightDenominator)
        : round1(rows.reduce((acc, row) => acc + row.avgHeightCm, 0) / Math.max(1, rows.length));
    points.push({
      round,
      date: sameDate ? dates[0] : dates.filter(Boolean).join(' / '),
      aligned,
      aliveCount,
      surveyIds: rows.map((row) => row.id),
      avgHeightCm,
    });
    if (!aligned) heldRounds.push(round);
  }
  return { points, heldRounds };
}

/**
 * 校验一条重划记录能否接平。顺序：先查地块/宗地是否齐全，再核权属面积，最后（并宗）核测次。
 * 任一项不过即置 hold 并给出原因码；调用方据此禁止出补植计划。
 */
export function checkAdjustment(
  adj: Pick<ParcelAdjustment, 'mode' | 'oldParcelCodes' | 'newParcelCodes' | 'parentPlotIds' | 'successorPlotIds'>,
  context: { parcels: Parcel[]; plots: Plot[]; surveys: Survey[] },
): AdjustmentCheckResult {
  const { parcels, plots, surveys } = context;

  const expectedParentCount = adj.mode === 'merge' ? adj.oldParcelCodes.length : 1;
  const expectedSuccessorCount = adj.mode === 'merge' ? 1 : adj.newParcelCodes.length;

  if (adj.parentPlotIds.length !== expectedParentCount || adj.successorPlotIds.length !== expectedSuccessorCount) {
    return { linkState: 'hold', holdReason: 'missingPlot', heldRounds: [] };
  }
  if (!adj.parentPlotIds.every((id) => plots.some((plot) => plot.id === id)) ||
      !adj.successorPlotIds.every((id) => plots.some((plot) => plot.id === id))) {
    return { linkState: 'hold', holdReason: 'missingPlot', heldRounds: [] };
  }
  if (!hasAllParcels(adj.oldParcelCodes, parcels)) {
    return { linkState: 'hold', holdReason: 'missingOldParcel', heldRounds: [] };
  }
  if (!hasAllParcels(adj.newParcelCodes, parcels)) {
    return { linkState: 'hold', holdReason: 'missingNewParcel', heldRounds: [] };
  }

  // 权属面积守恒：新宗地面积合计应与老宗地合计相符（容许测量误差）
  const oldArea = parcelArea(adj.oldParcelCodes, parcels);
  const newArea = parcelArea(adj.newParcelCodes, parcels);
  if (oldArea > 0) {
    const drift = Math.abs(newArea - oldArea) / oldArea;
    if (drift > PARCEL_AREA_TOLERANCE) {
      return { linkState: 'hold', holdReason: 'areaMismatch', heldRounds: [] };
    }
  }

  if (adj.mode === 'merge') {
    const { heldRounds } = mergeAlignedRounds(adj.parentPlotIds, surveys);
    if (heldRounds.length > 0) {
      return { linkState: 'hold', holdReason: 'roundMisaligned', heldRounds };
    }
  }

  return { linkState: 'linked', holdReason: 'none', heldRounds: [] };
}

/* --------------------------- 并宗成活率聚合 --------------------------- */

export interface LineageContext {
  mode: AdjustmentMode;
  adjustment: ParcelAdjustment;
  /** 并宗时贡献分母的老地块 id 列表 */
  contributingPlotIds: string[];
  /** 是否处于挂起复核 */
  held: boolean;
}

/** 解析某地块在重划谱系中的聚合上下文；非承接方返回 undefined（按普通地块处理） */
export function resolveLineage(
  plotId: string,
  adjustments: ParcelAdjustment[],
): LineageContext | undefined {
  const adj = findSuccessorAdjustment(plotId, adjustments);
  if (!adj) return undefined;
  return {
    mode: adj.mode,
    adjustment: adj,
    // 并宗：跨各老地块聚合；分宗：新地块自起测次，不并入老地块历史
    contributingPlotIds: adj.mode === 'merge' ? adj.parentPlotIds : [plotId],
    held: adj.linkState === 'hold',
  };
}

/**
 * 并宗合并地块的成活率汇总：
 * 分母 = 各老地块栽植总株数相加；分子按对齐测次的成活株数相加；挂起测次不参与最新值与补植测算。
 */
export function buildMergedSurvivalSummary(
  plotId: string,
  adj: ParcelAdjustment,
  surveys: Survey[],
  plantings: Planting[],
  threshold: number = SURVIVAL_WARN_RATE,
): SurvivalSummary {
  const parentIds = adj.parentPlotIds;
  const totalCount = plantings
    .filter((row) => parentIds.includes(row.plotId))
    .reduce((acc, row) => acc + row.count, 0);

  const { points: raw } = mergeAlignedRounds(parentIds, surveys);
  const heldSet = new Set(adj.heldRounds);

  const points: SurvivalPoint[] = raw
    .filter((item) => item.aligned && !heldSet.has(item.round))
    .map((item) => {
      const rate = totalCount > 0 ? calcSurvivalRate(item.aliveCount, totalCount) : 0;
      return {
        // 伪 id，仅用于列表 key；并宗地块本身不持有真实 survey 行
        surveyId: `merge:${item.round}`,
        round: item.round,
        date: item.date,
        aliveCount: item.aliveCount,
        avgHeightCm: item.avgHeightCm,
        rate,
        gradeManual: false,
        level: rateLevel(rate),
      };
    });

  const latest = points.length > 0 ? points[points.length - 1] : null;
  const previous = points.length > 1 ? points[points.length - 2] : null;

  return {
    plotId,
    totalCount,
    points,
    latest,
    previous,
    latestRate: latest ? latest.rate : 0,
    trend: latest && previous ? round1(latest.rate - previous.rate) : 0,
    heightDelta: latest && previous ? round1(latest.avgHeightCm - previous.avgHeightCm) : 0,
    heightPct:
      latest && previous && previous.avgHeightCm > 0
        ? round1(((latest.avgHeightCm - previous.avgHeightCm) / previous.avgHeightCm) * 100)
        : 0,
    suggestReplant: latest ? suggestReplantCount(totalCount, latest.aliveCount) : 0,
    level: latest ? latest.level : 'poor',
    // 有挂起测次或尚无任何接平测次时，不允许据此刻画为正常达标，交由闸门统一拦截补植
    warn: latest !== null && latest.rate < threshold,
  };
}

/**
 * 谱系感知的成活率汇总：
 *   - 并宗承接地块：跨老地块按株数聚合；
 *   - 其余（普通地块 / 分宗承接地块）：按本地块真实栽植与验收派生；
 *     分宗老地块的历史测次保留在老地块自身（只读），不在此并入新地块。
 */
export function buildLineageSummary(
  plot: Plot,
  surveys: Survey[],
  plantings: Planting[],
  adjustments: ParcelAdjustment[],
  threshold: number = SURVIVAL_WARN_RATE,
): SurvivalSummary {
  const lineage = resolveLineage(plot.id, adjustments);
  if (lineage && lineage.mode === 'merge') {
    return buildMergedSurvivalSummary(plot.id, lineage.adjustment, surveys, plantings, threshold);
  }
  return buildSurvivalSummary(plot.id, surveys, plantings, threshold);
}

/* ------------------------------ 补植闸门 ------------------------------ */

export interface ReplantGate {
  allowed: boolean;
  /** 不允许出补植计划时的面向用户原因 */
  reason: string;
  /** 只读（连录入都不允许），区别于仅暂停补植 */
  readOnly: boolean;
}

/**
 * 是否允许为某地块出补植计划。
 * 只读（宗地回填不出 / 历史老地块）或宗地重划挂起复核期间，一律不出补植计划。
 */
export function replantGate(
  plot: Plot,
  adjustments: ParcelAdjustment[],
  surveys: Survey[] = [],
  plantings: Planting[] = [],
): ReplantGate {
  if (plot.readOnly) {
    return {
      allowed: false,
      readOnly: true,
      reason: plot.parcelCode === ''
        ? '该历史地块回填不出权属宗地，按只读保留，暂不出补植计划。'
        : '该地块已在并宗/分宗后被替代（历史老地块，只读），补植在承接地块上安排。',
    };
  }

  const adj = findSuccessorAdjustment(plot.id, adjustments);
  if (adj && adj.linkState === 'hold') {
    return { allowed: false, readOnly: false, reason: `宗地${adj.mode === 'merge' ? '并宗' : '分宗'}记录挂起复核中，挂起期间不出补植计划。` };
  }

  if (adj?.mode === 'merge') {
    const summary = buildMergedSurvivalSummary(plot.id, adj, surveys, plantings);
    if (summary.points.length === 0) {
      return { allowed: false, readOnly: false, reason: '并宗各方没有可对齐的历史验收测次，待复核接平后再出补植计划。' };
    }
  }

  return { allowed: true, readOnly: false, reason: '' };
}
