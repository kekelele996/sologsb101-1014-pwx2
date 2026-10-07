/**
 * 权属宗地（Parcel）
 * 林业站权属台账单元：管宗地编号、权属面积与四至。
 * 与项目部「修复地块（Plot）」通过 parcelLinks 挂接表建立多对多关系
 * （direct 一一对应 / merge-source 并宗来源 / split-parent+split-child 分宗母子）。
 */

/** 宗地核对状态：正常 / 挂起复核（对不上先挂起，挂起期间不出补植计划） */
export type ParcelStatus = '正常' | '挂起复核';

/** 宗地来源：人工登记 / 升级时按原地块编号回填的历史宗地 */
export type ParcelSource = 'manual' | 'upgrade-backfill';

export const PARCEL_STATUS_OPTIONS: ParcelStatus[] = ['正常', '挂起复核'];

export interface Parcel {
  id: string;
  /** 宗地编号（林业站台账编号） */
  parcelCode: string;
  /** 权属人 / 权属单位 */
  ownerName: string;
  /** 权属面积（亩） */
  areaMu: number;
  /** 四至（东至…南至…西至…北至…） */
  boundaries: string;
  /** 重划生效日期 YYYY-MM-DD */
  effectiveDate: string;
  /** 核对状态 */
  status: ParcelStatus;
  /** 挂起复核原因（对不上的具体说明） */
  holdReason: string;
  /** 数据来源 */
  source: ParcelSource;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/** 新建 / 编辑宗地的表单草稿 */
export interface ParcelDraft {
  parcelCode: string;
  ownerName: string;
  areaMu: number;
  boundaries: string;
  effectiveDate: string;
}
