/**
 * 宗地权属台账状态管理（Zustand）
 * 管两本林业站数据：宗地（编号/权属面积/四至）与宗地重划记录（并宗/分宗）。
 * 重划记录保存时统一跑 checkAdjustment 自动接平：对不上即落为「挂起复核」，
 * 挂起期间由补植闸门（replantGate）拦截相关地块的补植计划。
 */
import { create } from 'zustand';
import { liveQuery } from 'dexie';
import type { Parcel, ParcelDraft } from '../types/parcel';
import type {
  HoldReason,
  ParcelAdjustment,
  ParcelAdjustmentDraft,
} from '../types/parcelAdjustment';
import {
  db,
  initDatabase,
  listParcels,
  listParcelAdjustments,
  putParcel,
  putParcelAdjustment,
  removeParcel,
  removeParcelAdjustment,
} from '../utils/db';
import { checkAdjustment } from '../utils/parcelLinkage';
import { nowIso, uuid } from '../utils/id';
import { usePlotStore } from './plotStore';

interface ParcelStoreState {
  parcels: Parcel[];
  adjustments: ParcelAdjustment[];
  loading: boolean;
  ready: boolean;
  revision: number;
  init: () => Promise<void>;
  createParcel: (draft: ParcelDraft) => Promise<Parcel>;
  updateParcel: (id: string, draft: ParcelDraft) => Promise<void>;
  deleteParcel: (id: string) => Promise<void>;
  /** 保存重划记录：自动接平校验，返回落库后的挂账状态与原因 */
  saveAdjustment: (draft: ParcelAdjustmentDraft, id?: string) => Promise<ParcelAdjustment>;
  /** 人工切换挂起/接平（人工挂起或复核通过） */
  setAdjustmentHold: (id: string, hold: boolean, reason?: HoldReason) => Promise<void>;
  deleteAdjustment: (id: string) => Promise<void>;
}

let subscribed = false;

export const useParcelStore = create<ParcelStoreState>((set, get) => ({
  parcels: [],
  adjustments: [],
  loading: true,
  ready: false,
  revision: 0,

  async init() {
    await initDatabase();
    if (!subscribed) {
      subscribed = true;
      liveQuery(async () => {
        const [parcels, adjustments] = await Promise.all([listParcels(), listParcelAdjustments()]);
        return { parcels, adjustments };
      }).subscribe({
        next: ({ parcels, adjustments }) => {
          set({ parcels, adjustments, loading: false, ready: true });
        },
        error: () => {
          set({ loading: false });
        },
      });
    }
    set({ revision: get().revision + 1 });
  },

  async createParcel(draft) {
    const stamp = nowIso();
    const row: Parcel = {
      id: uuid('parcel'),
      parcelCode: draft.parcelCode.trim(),
      areaMu: draft.areaMu,
      boundaries: { ...draft.boundaries },
      status: draft.status,
      source: 'forestry',
      createdAt: stamp,
      updatedAt: stamp,
      revision: 3,
    };
    await putParcel(row);
    set({ revision: get().revision + 1 });
    return row;
  },

  async updateParcel(id, draft) {
    const existing = await db.parcels.get(id);
    if (!existing) return;
    await putParcel({
      ...existing,
      parcelCode: draft.parcelCode.trim(),
      areaMu: draft.areaMu,
      boundaries: { ...draft.boundaries },
      status: draft.status,
    });
    set({ revision: get().revision + 1 });
  },

  async deleteParcel(id) {
    await removeParcel(id);
    set({ revision: get().revision + 1 });
  },

  async saveAdjustment(draft, id) {
    const { parcels } = get();
    const plots = usePlotStore.getState().plots;
    const surveys = usePlotStore.getState().surveys;

    const base: Pick<
      ParcelAdjustment,
      'mode' | 'oldParcelCodes' | 'newParcelCodes' | 'parentPlotIds' | 'successorPlotIds'
    > = {
      mode: draft.mode,
      oldParcelCodes: draft.oldParcelCodes.map((code) => code.trim()).filter(Boolean),
      newParcelCodes: draft.newParcelCodes.map((code) => code.trim()).filter(Boolean),
      parentPlotIds: draft.parentPlotIds,
      successorPlotIds: draft.successorPlotIds,
    };

    // 自动接平：地块/宗地齐全、面积守恒、（并宗）测次对齐
    const check = checkAdjustment(base, { parcels, plots, surveys });

    const existing = id ? await db.parcelAdjustments.get(id) : undefined;
    const stamp = nowIso();
    // 人工曾明确挂起则保留人工原因；否则以自动校验为准
    const linkState = existing && existing.linkState === 'hold' && existing.holdReason === 'manualHold'
      ? 'hold'
      : check.linkState;
    const holdReason: HoldReason =
      linkState === 'hold'
        ? existing && existing.holdReason === 'manualHold'
          ? 'manualHold'
          : check.holdReason
        : 'none';

    const row: ParcelAdjustment = {
      id: existing?.id ?? uuid('adj'),
      ...base,
      effectiveDate: draft.effectiveDate,
      linkState,
      holdReason,
      heldRounds: check.heldRounds,
      remark: draft.remark.trim(),
      createdAt: existing?.createdAt ?? stamp,
      updatedAt: stamp,
      revision: 3,
    };
    await putParcelAdjustment(row);

    // 落库后同步地块谱系角色与只读位
    await syncPlotLineage(row, plots);

    set({ revision: get().revision + 1 });
    return row;
  },

  async setAdjustmentHold(id, hold, reason = 'manualHold') {
    const existing = await db.parcelAdjustments.get(id);
    if (!existing) return;
    await putParcelAdjustment({
      ...existing,
      linkState: hold ? 'hold' : 'linked',
      holdReason: hold ? reason : 'none',
    });
    set({ revision: get().revision + 1 });
  },

  async deleteAdjustment(id) {
    await removeParcelAdjustment(id);
    set({ revision: get().revision + 1 });
  },
}));

/**
 * 根据一条重划记录同步项目部地块的谱系角色与只读位：
 *   - 老地块（parent）置 legacy + 只读；
 *   - 并宗承接地块置 mergeTarget，分宗承接地块置 splitChild（均可写新业务，但补植受闸门约束）。
 */
async function syncPlotLineage(
  adj: ParcelAdjustment,
  plots: { id: string }[],
): Promise<void> {
  for (const plotId of adj.parentPlotIds) {
    const plot = plots.find((item) => item.id === plotId) as
      | { id: string; lineageRole?: string; readOnly?: boolean }
      | undefined;
    if (plot) {
      await db.plots.update(plotId, { lineageRole: 'legacy', readOnly: true });
    }
  }
  for (const plotId of adj.successorPlotIds) {
    await db.plots.update(plotId, {
      lineageRole: adj.mode === 'merge' ? 'mergeTarget' : 'splitChild',
      readOnly: false,
    });
  }
}
