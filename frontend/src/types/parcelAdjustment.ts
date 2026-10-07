/**
 * 宗地重划记录（ParcelAdjustment）——林业站重划台账
 * 记录「相邻两宗并成一宗（merge 并宗）」与「一大宗拆成两宗（split 分宗）」，
 * 并把林业站新/老宗地编号与项目部老/新修复地块连接起来。
 *
 * 口径约定（详见 docs/parcel-linkage.md）：
 *   - merge 并宗：oldParcelCodes（≥2 宗）→ newParcelCode（1 宗）；
 *     并宗后成活率分母 = 各老地块栽植总株数直接相加（株数是可加量），
 *     成活株数按「同测次 + 同验收日期」对齐后相加，对不上的测次挂起复核。
 *   - split 分宗：oldParcelCode（1 宗）→ newParcelCodes（2 宗，分属不同班组）；
 *     分宗前的历史验收测次是整块地上做的抽样结果，无法在物理上切开，
 *     一律保留在老地块（parentPlotId）名下只读展示，不划归任一新地块；
 *     分宗生效日后各新地块各自重新起测次（从第 1 次开始）。
 */
import type { Parcel } from './parcel';

/** 重划方式：并宗 / 分宗 */
export type AdjustmentMode = 'merge' | 'split';

/**
 * 挂账状态：
 *   linked  已接平，可正常统计与出补植计划；
 *   hold    对不上挂起复核：挂起期间该重划涉及地块不出补植计划，成活率标注挂起。
 */
export type AdjustmentLinkState = 'linked' | 'hold';

export const ADJUSTMENT_MODE_OPTIONS: AdjustmentMode[] = ['merge', 'split'];
export const ADJUSTMENT_LINK_STATE_OPTIONS: AdjustmentLinkState[] = ['linked', 'hold'];

export const ADJUSTMENT_MODE_LABEL: Record<AdjustmentMode, string> = {
  merge: '并宗',
  split: '分宗',
};

export const ADJUSTMENT_LINK_STATE_LABEL: Record<AdjustmentLinkState, string> = {
  linked: '已接平',
  hold: '挂起复核',
};

/** 挂起复核原因码，便于界面统一翻译 */
export type HoldReason =
  | 'none'
  | 'missingOldParcel'
  | 'missingNewParcel'
  | 'areaMismatch'
  | 'roundMisaligned'
  | 'missingPlot'
  | 'manualHold';

export const HOLD_REASON_LABEL: Record<HoldReason, string> = {
  none: '',
  missingOldParcel: '老宗地编号在林业站台账中缺失',
  missingNewParcel: '新宗地编号在林业站台账中缺失',
  areaMismatch: '新老权属面积合计对不上，超出容许误差',
  roundMisaligned: '并宗各方同测次/验收日期对不上',
  missingPlot: '项目部老地块缺失或已删除',
  manualHold: '人工标记挂起，待林业站与项目部共同复核',
};

/** 权属面积容许相对误差（5%）：林业站重新确权测量本身有误差，超过才挂起 */
export const PARCEL_AREA_TOLERANCE = 0.05;

export interface ParcelAdjustment {
  id: string;
  /** 重划方式 */
  mode: AdjustmentMode;
  /** 并宗：老宗地编号列表（≥2）；分宗：单元素数组（1 宗） */
  oldParcelCodes: string[];
  /** 并宗：单元素数组（1 宗）；分宗：新宗地编号列表（2 宗） */
  newParcelCodes: string[];
  /**
   * 项目部老修复地块 id（栽植记录/历史验收仍挂在其下）。
   * 并宗时为各老宗地对应的老地块（≥2）；分宗时为被拆老地块（1）。
   */
  parentPlotIds: string[];
  /**
   * 重划生效后项目部对应的修复地块 id。
   * 并宗：新合并修复地块（1 个，分母跨老地块聚合）；
   * 分宗：各新宗地对应班组的新地块（2 个）。
   */
  successorPlotIds: string[];
  /** 重划生效日 YYYY-MM-DD：分宗时用于切分历史/新测次 */
  effectiveDate: string;
  /** 挂账状态 */
  linkState: AdjustmentLinkState;
  /** 挂起原因（linked 时为 none） */
  holdReason: HoldReason;
  /** 并宗时按测次对齐后，需要挂起的测次序号（如各方测次/日期对不上） */
  heldRounds: number[];
  /** 备注（班组划分说明等） */
  remark: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/** 新建重划记录的表单草稿 */
export interface ParcelAdjustmentDraft {
  mode: AdjustmentMode;
  oldParcelCodes: string[];
  newParcelCodes: string[];
  parentPlotIds: string[];
  successorPlotIds: string[];
  effectiveDate: string;
  remark: string;
}

/** 校验一条重划记录所需的最小外部数据（由 db 层/纯函数传入，便于单测） */
export interface AdjustmentCheckContext {
  parcels: Parcel[];
  plotIds: string[];
}
