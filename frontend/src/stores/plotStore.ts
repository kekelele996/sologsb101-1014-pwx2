/**
 * 地块状态管理（Zustand）
 * 维护地块列表、当前选中地块、筛选条件与地块级派生统计；
 * 所有写操作同步落 IndexedDB，写完后由 liveQuery 自动回灌。
 */
import { create } from 'zustand';
import { liveQuery } from 'dexie';
import type { Plot, PlotDraft, Substrate, TideZone } from '../types/plot';
import type { Seedling } from '../types/seedling';
import type { Planting } from '../types/planting';
import type { Survey, RateLevel } from '../types/survey';
import type { Parcel } from '../types/parcel';
import type { ParcelAdjustment } from '../types/parcelAdjustment';
import {
  DB_SCHEMA_VERSION,
  ROW_REVISION,
  countAll,
  db,
  initDatabase,
  putPlot,
  removePlot,
} from '../utils/db';
import { buildSurvivalSummary, type SurvivalSummary } from '../hooks/useSurvivalRate';
import { buildLineageSummary, replantGate, type ReplantGate } from '../utils/parcelLinkage';
import { nowIso, uuid } from '../utils/id';

/** 地块筛选条件（关键字 + 潮位带 + 底质），由 <FilterBar> 同步到 URL query */
export interface PlotFilters {
  keyword: string;
  tideZone: TideZone | 'all';
  substrate: Substrate | 'all';
}

/** 单个地块的派生统计，供地块台账与补植计划页复用 */
export interface PlotStat {
  plotId: string;
  /** 苗木批次数 */
  seedlingCount: number;
  /** 进场苗木合计（株） */
  seedlingQuantity: number;
  /** 栽植总株数（株，含并宗跨老地块聚合） */
  plantTotal: number;
  /** 验收测次数（并宗时为可对齐测次数） */
  surveyCount: number;
  /** 最新成活率（%） */
  latestRate: number;
  /** 最新等级 */
  level: RateLevel;
  /** 成活率环比变化（百分点） */
  trend: number;
  /** 建议补植株数 */
  suggestReplant: number;
  /** 是否只读（宗地回填不出 / 历史老地块） */
  readOnly: boolean;
  /** 关联宗地编号 */
  parcelCode: string;
  /** 补植闸门结果：挂起/只读期间不允许出补植计划 */
  gate: ReplantGate;
}

const EMPTY_FILTERS: PlotFilters = { keyword: '', tideZone: 'all', substrate: 'all' };
const CURRENT_PLOT_KEY = 'gbmangrove:currentPlotId';

function readCurrentPlotId(): string | null {
  try {
    const raw = window.localStorage.getItem(CURRENT_PLOT_KEY);
    return raw === null || raw === '' ? null : raw;
  } catch {
    return null;
  }
}

function writeCurrentPlotId(id: string | null): void {
  try {
    window.localStorage.setItem(CURRENT_PLOT_KEY, id ?? '');
  } catch {
    /* 隐私模式下写入失败时静默降级 */
  }
}

interface PlotStoreState {
  plots: Plot[];
  seedlings: Seedling[];
  plantings: Planting[];
  surveys: Survey[];
  parcels: Parcel[];
  adjustments: ParcelAdjustment[];
  currentPlotId: string | null;
  loading: boolean;
  ready: boolean;
  error: string;
  filters: PlotFilters;
  counts: Record<string, number>;
  stats: Record<string, PlotStat>;
  summaries: Record<string, SurvivalSummary>;
  /** 订阅 Dexie 并载入全部派生数据（幂等，可重复调用） */
  loadAll: () => Promise<void>;
  selectPlot: (plotId: string | null) => void;
  createPlot: (draft: PlotDraft) => Promise<Plot>;
  updatePlot: (plotId: string, draft: PlotDraft) => Promise<void>;
  deletePlot: (plotId: string) => Promise<void>;
  setFilters: (patch: Partial<PlotFilters>) => void;
  resetFilters: () => void;
  visiblePlots: () => Plot[];
  statOf: (plotId: string) => PlotStat;
  summaryOf: (plotId: string | null) => SurvivalSummary;
  refreshCounts: () => Promise<void>;
}

const EMPTY_STAT: Omit<PlotStat, 'plotId'> = {
  seedlingCount: 0,
  seedlingQuantity: 0,
  plantTotal: 0,
  surveyCount: 0,
  latestRate: 0,
  level: 'poor',
  trend: 0,
  suggestReplant: 0,
  readOnly: false,
  parcelCode: '',
  gate: { allowed: true, readOnly: false, reason: '' },
};

let subscribed = false;

export const usePlotStore = create<PlotStoreState>((set, get) => ({
  plots: [],
  seedlings: [],
  plantings: [],
  surveys: [],
  parcels: [],
  adjustments: [],
  currentPlotId: readCurrentPlotId(),
  loading: true,
  ready: false,
  error: '',
  filters: { ...EMPTY_FILTERS },
  counts: {},
  stats: {},
  summaries: {},

  async loadAll() {
    set({ loading: true, error: '' });
    try {
      await initDatabase();
      if (!subscribed) {
        subscribed = true;
        liveQuery(async () => {
          const [plots, seedlings, plantings, surveys, parcels, adjustments] = await Promise.all([
            db.plots.toArray(),
            db.seedlings.toArray(),
            db.plantings.toArray(),
            db.surveys.toArray(),
            db.parcels.toArray(),
            db.parcelAdjustments.toArray(),
          ]);
          return { plots, seedlings, plantings, surveys, parcels, adjustments };
        }).subscribe({
          next: ({ plots, seedlings, plantings, surveys, parcels, adjustments }) => {
            const stats: Record<string, PlotStat> = {};
            const summaries: Record<string, SurvivalSummary> = {};
            plots.forEach((plot) => {
              const plotSeedlings = seedlings.filter((row) => row.plotId === plot.id);
              // 谱系感知：并宗承接地块跨老地块按株数聚合；分宗新区用自身数据；老地块只读留历史
              const summary = buildLineageSummary(plot, surveys, plantings, adjustments);
              summaries[plot.id] = summary;
              const gate = replantGate(plot, adjustments, surveys, plantings);
              stats[plot.id] = {
                plotId: plot.id,
                seedlingCount: plotSeedlings.length,
                seedlingQuantity: plotSeedlings.reduce((acc, row) => acc + row.quantity, 0),
                plantTotal: summary.totalCount,
                surveyCount: summary.points.length,
                latestRate: summary.latestRate,
                level: summary.level,
                trend: summary.trend,
                suggestReplant: summary.suggestReplant,
                readOnly: plot.readOnly,
                parcelCode: plot.parcelCode,
                gate,
              };
            });
            const sorted = [...plots].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
            const current = get().currentPlotId;
            const stillExists = current !== null && plots.some((plot) => plot.id === current);
            set({
              plots: sorted,
              seedlings,
              plantings,
              surveys,
              parcels,
              adjustments,
              stats,
              summaries,
              loading: false,
              ready: true,
              error: '',
            });
            if (!stillExists) {
              const nextId = sorted.length > 0 ? sorted[0].id : null;
              set({ currentPlotId: nextId });
              writeCurrentPlotId(nextId);
            }
          },
          error: (err: unknown) => {
            set({ loading: false, error: err instanceof Error ? err.message : '读取地块数据失败' });
          },
        });
      }
      await get().refreshCounts();
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : '初始化本地数据库失败' });
    }
  },

  selectPlot(plotId) {
    set({ currentPlotId: plotId });
    writeCurrentPlotId(plotId);
  },

  async createPlot(draft) {
    const stamp = nowIso();
    const row: Plot = {
      id: uuid('plot'),
      name: draft.name.trim() || '未命名地块',
      areaMu: draft.areaMu,
      tideZone: draft.tideZone,
      substrate: draft.substrate,
      restoreMode: draft.restoreMode,
      state: draft.state,
      // 新建地块若未关联宗地编号，先按只读挂起，待林业站确认后再放开
      parcelCode: draft.parcelCode.trim(),
      lineageRole: 'normal',
      readOnly: draft.parcelCode.trim() === '',
      missingCount: 0,
      lastReplantDate: '',
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    };
    await putPlot(row);
    get().selectPlot(row.id);
    return row;
  },

  async updatePlot(plotId, draft) {
    const existing = await db.plots.get(plotId);
    if (!existing) return;
    const parcelCode = draft.parcelCode.trim();
    await putPlot({
      ...existing,
      name: draft.name.trim() || existing.name,
      areaMu: draft.areaMu,
      tideZone: draft.tideZone,
      substrate: draft.substrate,
      restoreMode: draft.restoreMode,
      state: draft.state,
      // 谱系角色（并宗/分宗/历史）由重划记录驱动，普通编辑不改；仅同步宗地编号
      parcelCode,
      readOnly: existing.lineageRole === 'normal' ? parcelCode === '' : existing.readOnly,
    });
  },

  async deletePlot(plotId) {
    await removePlot(plotId);
    if (get().currentPlotId === plotId) {
      get().selectPlot(null);
    }
    await get().refreshCounts();
  },

  setFilters(patch) {
    set({ filters: { ...get().filters, ...patch } });
  },

  resetFilters() {
    set({ filters: { ...EMPTY_FILTERS } });
  },

  visiblePlots() {
    const { plots, filters } = get();
    const keyword = filters.keyword.trim().toLowerCase();
    return plots.filter((plot) => {
      if (filters.tideZone !== 'all' && plot.tideZone !== filters.tideZone) return false;
      if (filters.substrate !== 'all' && plot.substrate !== filters.substrate) return false;
      if (keyword === '') return true;
      return (
        plot.name.toLowerCase().includes(keyword) ||
        plot.restoreMode.toLowerCase().includes(keyword) ||
        plot.state.toLowerCase().includes(keyword)
      );
    });
  },

  statOf(plotId) {
    return get().stats[plotId] ?? { plotId, ...EMPTY_STAT };
  },

  summaryOf(plotId) {
    if (plotId === null) return buildSurvivalSummary('', [], []);
    return get().summaries[plotId] ?? buildSurvivalSummary(plotId, [], []);
  },

  async refreshCounts() {
    const counts = await countAll();
    set({ counts: { ...counts, schemaVersion: DB_SCHEMA_VERSION } });
  },
}));
