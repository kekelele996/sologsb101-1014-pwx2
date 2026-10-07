/**
 * 修复地块（Plot）
 * 红树林修复项目的最小管理单元，按潮位带与底质区分立地条件。
 */

/** 潮位带：低 / 中 / 高 */
export type TideZone = '低' | '中' | '高';

/** 底质：淤泥质 / 砂质 / 砂泥质 */
export type Substrate = '淤泥质' | '砂质' | '砂泥质';

/** 修复方式：造林 / 补植 / 自然恢复 */
export type RestoreMode = '造林' | '补植' | '自然恢复';

/** 地块跟踪状态：跟踪中 / 已验收 */
export type PlotState = '跟踪中' | '已验收';

/**
 * 地块在宗地重划谱系中的角色：
 *   normal      普通地块，直接 1:1 挂一宗现行宗地；
 *   mergeTarget 并宗后的合并地块：自身无独立栽植/验收，跨各老地块按株数聚合；
 *   splitChild  分宗后某班组承接的新地块：生效日起各自新起测次；
 *   legacy      并宗/分宗后被替代的老地块：其栽植与历史验收只读保留。
 */
export type PlotLineageRole = 'normal' | 'mergeTarget' | 'splitChild' | 'legacy';

export const PLOT_LINEAGE_ROLE_LABEL: Record<PlotLineageRole, string> = {
  normal: '常规',
  mergeTarget: '并宗合并地块',
  splitChild: '分宗承接地块',
  legacy: '历史老地块（只读）',
};

export const TIDE_ZONE_OPTIONS: TideZone[] = ['低', '中', '高'];
export const SUBSTRATE_OPTIONS: Substrate[] = ['淤泥质', '砂质', '砂泥质'];
export const RESTORE_MODE_OPTIONS: RestoreMode[] = ['造林', '补植', '自然恢复'];
export const PLOT_STATE_OPTIONS: PlotState[] = ['跟踪中', '已验收'];

export interface Plot {
  id: string;
  /** 地块名 */
  name: string;
  /** 面积（亩） */
  areaMu: number;
  /** 潮位带 */
  tideZone: TideZone;
  /** 底质 */
  substrate: Substrate;
  /** 修复方式 */
  restoreMode: RestoreMode;
  /** 跟踪状态 */
  state: PlotState;
  /**
   * 当前生效宗地编号（关联林业站权属台账 Parcel.parcelCode）。
   * 升级回填不出的历史地块为空串，此时该地块只读保留。
   */
  parcelCode: string;
  /** 在宗地重划谱系中的角色 */
  lineageRole: PlotLineageRole;
  /**
   * 只读标记：true 时该地块及其栽植/验收只读、不允许新增或生成补植计划。
   * 两类情形置位：① 升级时回填不出宗地；② 已被并宗/分宗替代的历史老地块。
   */
  readOnly: boolean;
  /** 缺株数（株）——补植完成后由此回写 */
  missingCount: number;
  /** 最近一次补植/复壮回写日期 */
  lastReplantDate: string;
  createdAt: string;
  updatedAt: string;
  /** 数据行结构修订号，便于后续按行迁移 */
  revision: number;
}

/** 新建 / 编辑地块时的表单草稿 */
export interface PlotDraft {
  name: string;
  areaMu: number;
  tideZone: TideZone;
  substrate: Substrate;
  restoreMode: RestoreMode;
  state: PlotState;
  /** 关联的现行宗地编号（可暂空，空表示待林业站确认） */
  parcelCode: string;
}
