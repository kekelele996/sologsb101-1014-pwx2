/**
 * 权属宗地对接收口工具（纯函数，不碰数据库）
 * - 宗地 ↔ 地块挂接关系解析（direct / 并宗 / 分宗）
 * - 并宗成活率：分母按各老地块栽植总株数相加（不按权属面积加权）
 * - 分宗成活率：历史测次留母块只读继承，分宗后新测次归子块
 * - 对不上的自动识别 → 挂起复核；挂起期间不出补植计划
 */
import type { Parcel } from '../types/parcel';
import type { ParcelLink, ParcelLinkType } from '../types/parcelLink';
import type { Plot } from '../types/plot';
import type { Planting } from '../types/planting';
import type { Survey } from '../types/survey';
import { calcSurvivalRate, round1 } from './rate';

/** 权属面积与地块面积合计的允许偏差（%），超出即挂起复核 */
export const PARCEL_AREA_TOLERANCE_PCT = 2;

/** 一宗地按其挂接关系解析出的结构 */
export type ParcelShape = 'direct' | 'merge' | 'split' | 'orphan';

/** 并宗单个测次的聚合结果 */
export interface MergeRound {
  round: number;
  /** 该测次涉及的老地块（缺测次的不计入） */
  plotIds: string[];
  aliveCount: number;
  totalCount: number;
  rate: number;
}

/** 分宗继承自测宗母块的历史测次 */
export interface InheritedSurvey {
  survey: Survey;
  /** 母块 id */
  parentPlotId: string;
}

/** 宗地挂接视图：成活率口径与挂起问题都从这里派生 */
export interface ParcelView {
  parcelId: string;
  shape: ParcelShape;
  /** 直接对应的地块（direct） */
  directPlot: Plot | null;
  /** 并宗来源老地块 */
  mergeSourcePlots: Plot[];
  /** 分宗母块 */
  splitParentPlot: Plot | null;
  /** 分宗子块（挂当前宗地） */
  splitChildPlots: Plot[];
  /** 参与本宗地统计口径的地块：并宗=所有来源地块；direct=本地块；分宗=各子块 */
  scopePlotIds: string[];
  /** 分宗子块 → 班组 / 分宗面积 */
  childLinks: ParcelLink[];
  /** 自动发现的对不上问题（非空即应挂起复核） */
  issues: string[];
  /** 地块面积合计（亩），用于与权属面积核对 */
  linkedAreaSum: number;
}

function byType(links: ParcelLink[], type: ParcelLinkType): ParcelLink[] {
  return links.filter((link) => link.linkType === type);
}

/** 解析一宗地的挂接视图 */
export function buildParcelView(
  parcel: Parcel,
  links: ParcelLink[],
  plots: Plot[],
): ParcelView {
  const own = links.filter((link) => link.parcelId === parcel.id);
  const directLinks = byType(own, 'direct');
  const mergeLinks = byType(own, 'merge-source');
  const parentLinks = byType(own, 'split-parent');
  const childLinks = byType(own, 'split-child').sort((a, b) => a.splitAreaMu - b.splitAreaMu);

  const plotMap = new Map(plots.map((plot) => [plot.id, plot]));
  const toPlot = (link: ParcelLink): Plot | null => plotMap.get(link.plotId) ?? null;

  const directPlot = directLinks.length === 1 ? toPlot(directLinks[0]) : null;
  const mergeSourcePlots = mergeLinks.map(toPlot).filter((plot): plot is Plot => plot !== null);
  const splitParentPlot = parentLinks.length === 1 ? toPlot(parentLinks[0]) : null;
  const splitChildPlots = childLinks.map(toPlot).filter((plot): plot is Plot => plot !== null);

  let shape: ParcelShape = 'orphan';
  let scopePlotIds: string[] = [];
  if (mergeLinks.length >= 2) {
    shape = 'merge';
    scopePlotIds = mergeSourcePlots.map((plot) => plot.id);
  } else if (childLinks.length >= 1 || parentLinks.length === 1) {
    shape = 'split';
    scopePlotIds = splitChildPlots.map((plot) => plot.id);
  } else if (directLinks.length === 1 && directPlot !== null) {
    shape = 'direct';
    scopePlotIds = [directPlot.id];
  }

  const linkedAreaSum = round1(
    shape === 'split'
      ? childLinks.reduce((acc, link) => acc + (link.splitAreaMu > 0 ? link.splitAreaMu : 0), 0)
      : scopePlotIds.reduce((acc, id) => acc + (plotMap.get(id)?.areaMu ?? 0), 0),
  );

  return {
    parcelId: parcel.id,
    shape,
    directPlot,
    mergeSourcePlots,
    splitParentPlot,
    splitChildPlots,
    scopePlotIds,
    childLinks,
    issues: [],
    linkedAreaSum,
  };
}

/** 地块栽植总株数 */
export function plotPlantedTotal(plotId: string, plantings: Planting[]): number {
  return plantings
    .filter((row) => row.plotId === plotId)
    .reduce((acc, row) => acc + row.count, 0);
}

/**
 * 并宗成活率口径：
 * 分母 = 各老地块栽植总株数相加（不按权属面积加权）；
 * 成活株数按同测次跨宗相加；某老地块缺该测次则该测次挂起复核，不硬凑分母。
 */
export function buildMergeRounds(
  sourcePlotIds: string[],
  surveys: Survey[],
  plantings: Planting[],
): { rounds: MergeRound[]; missingRoundPlots: string[] } {
  const totals = new Map<string, number>(
    sourcePlotIds.map((id) => [id, plotPlantedTotal(id, plantings)]),
  );
  const allRounds = Array.from(
    new Set(
      surveys
        .filter((row) => sourcePlotIds.includes(row.plotId))
        .map((row) => row.round),
    ),
  ).sort((a, b) => a - b);

  const rounds: MergeRound[] = [];
  const missingRoundPlots: string[] = [];
  for (const round of allRounds) {
    let aliveCount = 0;
    let totalCount = 0;
    const plotIds: string[] = [];
    for (const plotId of sourcePlotIds) {
      const point = surveys.find((row) => row.plotId === plotId && row.round === round);
      if (point === undefined) {
        if (!missingRoundPlots.includes(plotId)) missingRoundPlots.push(plotId);
        continue;
      }
      plotIds.push(plotId);
      aliveCount += point.aliveCount;
      totalCount += totals.get(plotId) ?? 0;
    }
    rounds.push({
      round,
      plotIds,
      aliveCount,
      totalCount,
      rate: calcSurvivalRate(aliveCount, totalCount),
    });
  }
  return { rounds, missingRoundPlots };
}

/** 自动识别宗地的对不上问题；返回问题清单（空数组表示对得上） */
export function detectParcelIssues(
  parcel: Parcel,
  view: ParcelView,
  surveys: Survey[],
  plantings: Planting[],
): string[] {
  const issues: string[] = [...view.issues];

  if (view.shape === 'orphan') {
    issues.push('该宗地尚未挂接任何修复地块，无法对接项目部栽植与验收数据。');
    return issues;
  }

  // 权属面积与地块侧面积合计核对
  if (parcel.areaMu > 0 && view.linkedAreaSum > 0) {
    const diffPct = round1((Math.abs(parcel.areaMu - view.linkedAreaSum) / parcel.areaMu) * 100);
    if (diffPct > PARCEL_AREA_TOLERANCE_PCT) {
      issues.push(
        `权属面积 ${parcel.areaMu} 亩与挂接地块面积合计 ${view.linkedAreaSum} 亩偏差 ${diffPct}%，超过 ${PARCEL_AREA_TOLERANCE_PCT}% 容差。`,
      );
    }
  }

  if (view.shape === 'merge') {
    const { missingRoundPlots } = buildMergeRounds(view.scopePlotIds, surveys, plantings);
    missingRoundPlots.forEach((plotId) => {
      const name = view.mergeSourcePlots.find((plot) => plot.id === plotId)?.name ?? plotId;
      issues.push(`并宗后测次不齐：老地块「${name}」缺少部分验收测次，无法跨宗同测次相加。`);
    });
    const zeroTotal = view.mergeSourcePlots.filter((plot) => plotPlantedTotal(plot.id, plantings) <= 0);
    zeroTotal.forEach((plot) => {
      issues.push(`并宗来源老地块「${plot.name}」没有栽植记录，成活率分母缺项。`);
    });
  }

  if (view.shape === 'split') {
    if (view.splitParentPlot === null) {
      issues.push('分宗宗地缺少分宗母块挂接，历史验收测次无处留档。');
    }
    const noArea = view.childLinks.filter((link) => !(link.splitAreaMu > 0));
    if (noArea.length > 0) {
      issues.push(`${noArea.length} 个分宗子块未登记分宗面积，无法与权属面积核对。`);
    }
  }

  return issues;
}

/* --------------------------- 地块侧口径与冻结 --------------------------- */

/** 地块关联到的全部挂接边 */
export function linksOfPlot(plotId: string, links: ParcelLink[]): ParcelLink[] {
  return links.filter((link) => link.plotId === plotId);
}

/** 地块关联到的宗地 id 列表 */
export function parcelIdsOfPlot(plotId: string, links: ParcelLink[]): string[] {
  return Array.from(new Set(linksOfPlot(plotId, links).map((link) => link.parcelId)));
}

/** 是否分宗母块（历史栽植 / 测次留档，不再录新测次） */
export function isSplitParentPlot(plotId: string, links: ParcelLink[]): boolean {
  return linksOfPlot(plotId, links).some((link) => link.linkType === 'split-parent');
}

/** 是否分宗子块（新测次独立记在此侧） */
export function isSplitChildPlot(plotId: string, links: ParcelLink[]): boolean {
  return linksOfPlot(plotId, links).some((link) => link.linkType === 'split-child');
}

/**
 * 分宗子块继承的历史测次：同宗地母块在分宗生效前（母块上）的验收测次，
 * 只读展示、不进子块成活率分母、不拆株数。
 */
export function inheritedSurveys(
  plotId: string,
  links: ParcelLink[],
  surveys: Survey[],
  splitEffectiveDate: string,
): InheritedSurvey[] {
  const childLinks = linksOfPlot(plotId, links).filter((link) => link.linkType === 'split-child');
  const result: InheritedSurvey[] = [];
  for (const childLink of childLinks) {
    const parentLink = links.find(
      (link) => link.parcelId === childLink.parcelId && link.linkType === 'split-parent',
    );
    if (parentLink === undefined) continue;
    surveys
      .filter(
        (row) =>
          row.plotId === parentLink.plotId &&
          (splitEffectiveDate === '' || row.date <= splitEffectiveDate),
      )
      .sort((a, b) => a.round - b.round)
      .forEach((survey) => result.push({ survey, parentPlotId: parentLink.plotId }));
  }
  return result;
}

export type ReplantBlockReason =
  | 'readonly'
  | 'parcel-held'
  | 'split-parent'
  | 'no-parcel'
  | null;

/**
 * 地块是否被禁止出补植计划（挂起期间不出补植计划；只读 / 母块 / 无宗地同样冻结）。
 * 返回冻结原因，null 表示可以出。
 */
export function replantBlockReason(
  plot: Plot,
  parcels: Parcel[],
  links: ParcelLink[],
): ReplantBlockReason {
  if (plot.readonly === true) return 'readonly';
  if (isSplitParentPlot(plot.id, links)) return 'split-parent';
  const parcelIds = parcelIdsOfPlot(plot.id, links);
  if (parcelIds.length === 0) return 'no-parcel';
  const held = parcels.find((item) => parcelIds.includes(item.id) && item.status === '挂起复核');
  if (held !== undefined) return 'parcel-held';
  return null;
}

/** 冻结原因的中文说明（界面提示 / 补植页复用） */
export function replantBlockText(reason: ReplantBlockReason, parcel?: Parcel): string {
  switch (reason) {
    case 'readonly':
      return '该地块历史宗地回填不上，已只读保留，挂起复核期间不出补植计划。';
    case 'split-parent':
      return '该地块是分宗母块，历史测次仅留档；补植计划请在分宗后的班组子块上生成。';
    case 'no-parcel':
      return '该地块尚未挂接权属宗地，先到权属台账完成对接再出补植计划。';
    case 'parcel-held':
      return `关联宗地「${parcel?.parcelCode ?? ''}」正挂起复核，复核通过前不出补植计划。`;
    default:
      return '';
  }
}
