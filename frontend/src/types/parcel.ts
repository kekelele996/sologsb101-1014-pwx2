/**
 * 宗地（Parcel）——林业站权属台账
 * 与项目部「修复地块（Plot）」分属两本账：
 *   - 本台账只登记权属口径：宗地编号、权属面积、四至；
 *   - 栽植记录、验收测次、补植计划仍挂在项目部修复地块（Plot）之下。
 * 修复地块通过 parcelCode 关联到当前生效宗地；宗地重划（并宗/分宗）见 parcelAdjustment.ts。
 */

/** 权属状态：有效（现行）/ 历史（并宗或分宗后被替代） */
export type ParcelStatus = 'active' | 'history';

/** 数据来源：forestry 林业站台账导入；legacyBackfill 升级时按老地块编号回填 */
export type ParcelSource = 'forestry' | 'legacyBackfill';

export const PARCEL_STATUS_OPTIONS: ParcelStatus[] = ['active', 'history'];
export const PARCEL_SOURCE_OPTIONS: ParcelSource[] = ['forestry', 'legacyBackfill'];

export const PARCEL_STATUS_LABEL: Record<ParcelStatus, string> = {
  active: '现行',
  history: '历史',
};

export interface Parcel {
  id: string;
  /** 宗地编号（林业站口径，全库唯一），如 GBM-2024-018 */
  parcelCode: string;
  /** 权属面积（亩）——林业站确权面积，作为权属口径唯一来源 */
  areaMu: number;
  /** 四至：东 / 南 / 西 / 北 界址说明 */
  boundaries: {
    east: string;
    south: string;
    west: string;
    north: string;
  };
  /** 权属状态 */
  status: ParcelStatus;
  /** 数据来源 */
  source: ParcelSource;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/** 新建 / 编辑宗地的表单草稿 */
export interface ParcelDraft {
  parcelCode: string;
  areaMu: number;
  boundaries: Parcel['boundaries'];
  status: ParcelStatus;
}
