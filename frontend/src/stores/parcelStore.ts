/**
 * 权属宗地状态管理（Zustand）
 * 维护林业站宗地台账、宗地—地块挂接边，并按 utils/parcel 纯函数派生
 * 每宗地的挂接视图（direct / 并宗 / 分宗 / 孤儿）与「对不上」问题清单。
 * 写操作同步落 IndexedDB，写完后由 liveQuery 自动回灌。
 */
import { create } from 'zustand';
import { liveQuery } from 'dexie';
import type { Parcel, ParcelDraft } from '../types/parcel';
import type { ParcelLink, ParcelLinkDraft } from '../types/parcelLink';
import type { Plot } from '../types/plot';
import type { Planting } from '../types/planting';
import type { Survey } from '../types/survey';
import {
  db,
  initDatabase,
  listParcels,
  listParcelLinks,
  putParcel,
  putParcelLink,
  removeParcel,
  removeParcelLink,
  ROW_REVISION,
} from '../utils/db';
import { buildParcelView, detectParcelIssues, type ParcelView } from '../utils/parcel';
import { nowIso, uuid } from '../utils/id';

interface ParcelStoreState {
  parcels: Parcel[];
  links: ParcelLink[];
  /** 项目部侧快照（地块 / 栽植 / 验收），用于派生挂接视图与挂起问题 */
  plots: Plot[];
  plantings: Planting[];
  surveys: Survey[];
  loading: boolean;
  ready: boolean;
  error: string;
  loadAll: () => Promise<void>;
  createParcel: (draft: ParcelDraft) => Promise<Parcel>;
  updateParcel: (id: string, draft: ParcelDraft) => Promise<void>;
  deleteParcel: (id: string) => Promise<void>;
  /** 手工挂起（带原因）/ 复核通过解除挂起 */
  holdParcel: (id: string, reason: string) => Promise<void>;
  releaseParcel: (id: string) => Promise<void>;
  createLink: (draft: ParcelLinkDraft) => Promise<ParcelLink>;
  deleteLink: (id: string) => Promise<void>;
  viewOf: (parcelId: string) => ParcelView;
  issuesOf: (parcelId: string) => string[];
}

let subscribed = false;

export const useParcelStore = create<ParcelStoreState>((set, get) => ({
  parcels: [],
  links: [],
  plots: [],
  plantings: [],
  surveys: [],
  loading: true,
  ready: false,
  error: '',

  async loadAll() {
    set({ loading: true, error: '' });
    try {
      await initDatabase();
      if (!subscribed) {
        subscribed = true;
        liveQuery(async () => {
          const [parcels, links, plots, plantings, surveys] = await Promise.all([
            listParcels(),
            listParcelLinks(),
            db.plots.toArray(),
            db.plantings.toArray(),
            db.surveys.toArray(),
          ]);
          return { parcels, links, plots, plantings, surveys };
        }).subscribe({
          next: ({ parcels, links, plots, plantings, surveys }) => {
            set({ parcels, links, plots, plantings, surveys, loading: false, ready: true, error: '' });
          },
          error: (err: unknown) => {
            set({ loading: false, error: err instanceof Error ? err.message : '读取权属台账失败' });
          },
        });
      }
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : '初始化权属台账失败' });
    }
  },

  async createParcel(draft) {
    const stamp = nowIso();
    const row: Parcel = {
      id: uuid('parcel'),
      parcelCode: draft.parcelCode.trim() || '未编号宗地',
      ownerName: draft.ownerName.trim() || '未登记权属人',
      areaMu: draft.areaMu,
      boundaries: draft.boundaries.trim(),
      effectiveDate: draft.effectiveDate,
      status: '正常',
      holdReason: '',
      source: 'manual',
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    };
    await putParcel(row);
    return row;
  },

  async updateParcel(id, draft) {
    const existing = await db.parcels.get(id);
    if (!existing) return;
    await putParcel({
      ...existing,
      parcelCode: draft.parcelCode.trim() || existing.parcelCode,
      ownerName: draft.ownerName.trim() || existing.ownerName,
      areaMu: draft.areaMu,
      boundaries: draft.boundaries.trim(),
      effectiveDate: draft.effectiveDate,
    });
  },

  async deleteParcel(id) {
    await removeParcel(id);
  },

  async holdParcel(id, reason) {
    const existing = await db.parcels.get(id);
    if (!existing) return;
    await putParcel({ ...existing, status: '挂起复核', holdReason: reason.trim() || '人工挂起，待复核。' });
  },

  async releaseParcel(id) {
    const issues = get().issuesOf(id);
    if (issues.length > 0) return; // 自动发现的问题未消，不允许解除
    const existing = await db.parcels.get(id);
    if (!existing) return;
    await putParcel({ ...existing, status: '正常', holdReason: '' });
  },

  async createLink(draft) {
    const stamp = nowIso();
    const row: ParcelLink = {
      id: uuid('plink'),
      parcelId: draft.parcelId,
      plotId: draft.plotId,
      linkType: draft.linkType,
      team: draft.team.trim(),
      splitAreaMu: draft.linkType === 'split-child' ? draft.splitAreaMu : 0,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    };
    await putParcelLink(row);
    return row;
  },

  async deleteLink(id) {
    await removeParcelLink(id);
  },

  viewOf(parcelId) {
    const { parcels, links, plots } = get();
    const parcel = parcels.find((item) => item.id === parcelId);
    return buildParcelView(
      parcel ?? {
        id: parcelId,
        parcelCode: '',
        ownerName: '',
        areaMu: 0,
        boundaries: '',
        effectiveDate: '',
        status: '正常',
        holdReason: '',
        source: 'manual',
        createdAt: '',
        updatedAt: '',
        revision: ROW_REVISION,
      },
      links,
      plots,
    );
  },

  issuesOf(parcelId) {
    const { parcels, links, plots, plantings, surveys } = get();
    const parcel = parcels.find((item) => item.id === parcelId);
    if (parcel === undefined) return [];
    const view = buildParcelView(parcel, links, plots);
    return detectParcelIssues(parcel, view, surveys, plantings);
  },
}));
