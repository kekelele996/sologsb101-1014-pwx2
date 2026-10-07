/**
 * 宗地—地块挂接关系（ParcelLink）
 * 林业站重划权属（并宗 / 分宗 / 一一对应）与项目部历史地块编号的对照表。
 * 每条记录表示「某宗地」与「某修复地块」之间的一条关系边。
 */

/**
 * 关系类型：
 * - direct：宗地与地块一一对应（重划未涉及该地块）
 * - merge-source：并宗——多个老地块合并进一个新宗地（老地块栽植、验收仍挂老编号）
 * - split-parent：分宗母块——重划前的大地块，历史栽植 / 验收测次保留在此
 * - split-child：分宗子块——重划后划给各班组的新地块，独立录新测次
 */
export type ParcelLinkType = 'direct' | 'merge-source' | 'split-parent' | 'split-child';

export const PARCEL_LINK_TYPE_LABEL: Record<ParcelLinkType, string> = {
  direct: '一一对应',
  'merge-source': '并宗来源',
  'split-parent': '分宗母块',
  'split-child': '分宗子块',
};

export const PARCEL_LINK_TYPE_OPTIONS: ParcelLinkType[] = [
  'direct',
  'merge-source',
  'split-parent',
  'split-child',
];

export interface ParcelLink {
  id: string;
  /** 所属宗地 */
  parcelId: string;
  /** 关联的修复地块 */
  plotId: string;
  /** 关系类型 */
  linkType: ParcelLinkType;
  /** 班组（分宗子块由不同班组承接时记录） */
  team: string;
  /** 该侧分宗面积（亩），仅 split-child 需要；并宗不按面积加权 */
  splitAreaMu: number;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/** 新建 / 编辑挂接关系的表单草稿 */
export interface ParcelLinkDraft {
  parcelId: string;
  plotId: string;
  linkType: ParcelLinkType;
  team: string;
  splitAreaMu: number;
}
