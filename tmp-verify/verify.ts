/* 临时验证：并宗/分宗接账纯逻辑（不触 IndexedDB，手工构造行） */
import type { Plot } from '../frontend/src/types/plot';
import type { Planting } from '../frontend/src/types/planting';
import type { Survey } from '../frontend/src/types/survey';
import type { Parcel } from '../frontend/src/types/parcel';
import type { ParcelAdjustment } from '../frontend/src/types/parcelAdjustment';
import {
  buildMergedSurvivalSummary,
  checkAdjustment,
  replantGate,
  buildLineageSummary,
} from '../frontend/src/utils/parcelLinkage';

let failures = 0;
function assert(cond: boolean, label: string, extra?: unknown): void {
  if (cond) {
    console.log(`  ✅ ${label}`);
  } else {
    failures += 1;
    console.error(`  ❌ ${label}`, extra ?? '');
  }
}

function survey(id: string, plotId: string, round: number, date: string, aliveCount: number): Survey {
  return {
    id, plotId, round, date, aliveCount, avgHeightCm: 50, survivalRate: 0,
    grade: 'fair', gradeManual: false, createdAt: '', updatedAt: '', revision: 3,
  };
}
function planting(plotId: string, count: number): Planting {
  return { id: `${plotId}-p`, plotId, seedlingId: 's', plantDate: '2024-01-01', spacingM: 1, count, operator: '班', createdAt: '', updatedAt: '', revision: 3 };
}
function plot(id: string, role: Plot['lineageRole'], readOnly: boolean, parcelCode: string): Plot {
  return {
    id, name: id, areaMu: 10, tideZone: '中', substrate: '淤泥质', restoreMode: '造林', state: '跟踪中',
    parcelCode, lineageRole: role, readOnly, missingCount: 0, lastReplantDate: '', createdAt: '', updatedAt: '', revision: 3,
  };
}
function parcel(parcelCode: string, areaMu: number): Parcel {
  return { id: parcelCode, parcelCode, areaMu, boundaries: { east: '', south: '', west: '', north: '' }, status: 'active', source: 'forestry', createdAt: '', updatedAt: '', revision: 3 };
}

/* ---------- 场景 1：并宗，测次对齐，分母按株数相加 ---------- */
console.log('并宗（对齐）');
{
  const plots = [plot('o1', 'legacy', true, 'P1'), plot('o2', 'legacy', true, 'P2'), plot('he', 'mergeTarget', false, 'PN')];
  const plantings = [planting('o1', 2000), planting('o2', 2600)];
  const surveys = [
    survey('s1', 'o1', 1, '2024-07-10', 1840), survey('s2', 'o2', 1, '2024-07-10', 2340),
    survey('s3', 'o1', 2, '2024-10-15', 1700), survey('s4', 'o2', 2, '2024-10-15', 2160),
  ];
  const parcels = [parcel('P1', 20), parcel('P2', 25), parcel('PN', 45)];
  const adj: ParcelAdjustment = {
    id: 'a', mode: 'merge', oldParcelCodes: ['P1', 'P2'], newParcelCodes: ['PN'],
    parentPlotIds: ['o1', 'o2'], successorPlotIds: ['he'], effectiveDate: '2025-01-01',
    linkState: 'linked', holdReason: 'none', heldRounds: [], remark: '', createdAt: '', updatedAt: '', revision: 3,
  };
  const check = checkAdjustment(adj, { parcels, plots, surveys });
  assert(check.linkState === 'linked', '自动接平为 linked');

  const sum = buildMergedSurvivalSummary('he', adj, surveys, plantings);
  assert(sum.totalCount === 4600, `分母为两老地块株数相加 4600（实得 ${sum.totalCount}）`);
  assert(sum.points.length === 2, `两个对齐测次（实得 ${sum.points.length}）`);
  // 第2测次：(1700+2160)/4600 = 83.91% -> 83.9
  assert(Math.abs(sum.latestRate - 83.9) < 0.05, `最新成活率 83.9%（实得 ${sum.latestRate}）`);
  assert(sum.latest !== null && sum.latest.aliveCount === 3860, `分子成活株数相加 3860（实得 ${sum.latest?.aliveCount}）`);

  const gate = replantGate(plots[2], [adj], surveys, plantings);
  assert(gate.allowed, '接平并宗地块允许出补植计划', gate);
}

/* ---------- 场景 2：并宗，第2测次日期错位 → 挂起，不出补植 ---------- */
console.log('并宗（测次错位挂起）');
{
  const plots = [plot('d1', 'legacy', true, 'D1'), plot('d2', 'legacy', true, 'D2'), plot('dh', 'mergeTarget', false, 'DN')];
  const plantings = [planting('d1', 1200), planting('d2', 1500)];
  const surveys = [
    survey('a1', 'd1', 1, '2024-08-01', 1080), survey('b1', 'd2', 1, '2024-08-01', 1320),
    survey('a2', 'd1', 2, '2024-11-02', 960), survey('b2', 'd2', 2, '2024-11-20', 1170),
  ];
  const parcels = [parcel('D1', 15), parcel('D2', 18), parcel('DN', 33)];
  const draft = {
    mode: 'merge' as const, oldParcelCodes: ['D1', 'D2'], newParcelCodes: ['DN'],
    parentPlotIds: ['d1', 'd2'], successorPlotIds: ['dh'],
  };
  const check = checkAdjustment(draft, { parcels, plots, surveys });
  assert(check.linkState === 'hold', '错位时自动挂起 hold');
  assert(check.holdReason === 'roundMisaligned', `原因为 roundMisaligned（实得 ${check.holdReason}）`);
  assert(JSON.stringify(check.heldRounds) === '[2]', `挂起测次=[2]（实得 ${JSON.stringify(check.heldRounds)}）`);

  const adj: ParcelAdjustment = {
    ...draft, id: 'a2', effectiveDate: '2025-01-01', linkState: 'hold',
    holdReason: check.holdReason, heldRounds: check.heldRounds, remark: '', createdAt: '', updatedAt: '', revision: 3,
  };
  const sum = buildMergedSurvivalSummary('dh', adj, surveys, plantings);
  // 仅第1测次参与：分子2400/2700
  assert(sum.totalCount === 2700, `分母仍为株数相加 2700（实得 ${sum.totalCount}）`);
  assert(sum.points.length === 1, `挂起测次剔除后仅 1 个点（实得 ${sum.points.length}）`);
  assert(Math.abs(sum.latestRate - 88.9) < 0.05, `仅按第1测次 88.9%（实得 ${sum.latestRate}）`);

  const gate = replantGate(plots[2], [adj], surveys, plantings);
  assert(!gate.allowed && !gate.readOnly, '挂起期间禁止出补植计划', gate);
}

/* ---------- 场景 3：面积守恒超差 → 挂起 ---------- */
console.log('面积不守恒');
{
  const plots = [plot('x1', 'legacy', true, 'X1'), plot('x2', 'legacy', true, 'X2'), plot('xh', 'mergeTarget', false, 'XN')];
  const parcels = [parcel('X1', 20), parcel('X2', 25), parcel('XN', 60)]; // 老合计45，新60，超5%
  const check = checkAdjustment(
    { mode: 'merge', oldParcelCodes: ['X1', 'X2'], newParcelCodes: ['XN'], parentPlotIds: ['x1', 'x2'], successorPlotIds: ['xh'] },
    { parcels, plots, surveys: [] },
  );
  assert(check.linkState === 'hold' && check.holdReason === 'areaMismatch', '面积超差挂起 areaMismatch', check);
}

/* ---------- 场景 4：分宗，历史测次留老地块，新区各自起测 ---------- */
console.log('分宗归属');
{
  const parent = plot('old', 'legacy', true, 'OLD');
  const c1 = plot('c1', 'splitChild', false, 'N1');
  const c2 = plot('c2', 'splitChild', false, 'N2');
  const plots = [parent, c1, c2];
  const plantings = [planting('old', 6000), planting('c1', 1800), planting('c2', 1700)];
  const surveys = [
    survey('h1', 'old', 1, '2024-06-10', 5400), survey('h2', 'old', 2, '2024-09-12', 5100),
    survey('n1', 'c1', 1, '2025-08-15', 1620), survey('n2', 'c2', 1, '2025-08-15', 1500),
  ];
  const adj: ParcelAdjustment = {
    id: 'sp', mode: 'split', oldParcelCodes: ['OLD'], newParcelCodes: ['N1', 'N2'],
    parentPlotIds: ['old'], successorPlotIds: ['c1', 'c2'], effectiveDate: '2025-05-01',
    linkState: 'linked', holdReason: 'none', heldRounds: [], remark: '', createdAt: '', updatedAt: '', revision: 3,
  };

  const sumC1 = buildLineageSummary(c1, surveys, plantings, [adj]);
  assert(sumC1.totalCount === 1800, `新区 c1 分母只用自身 1800（实得 ${sumC1.totalCount}）`);
  assert(sumC1.points.length === 1 && sumC1.points[0].aliveCount === 1620, '新区 c1 不继承老地块历史测次');

  const sumC2 = buildLineageSummary(c2, surveys, plantings, [adj]);
  assert(sumC2.totalCount === 1700, `新区 c2 分母只用自身 1700（实得 ${sumC2.totalCount}）`);

  // 老地块历史仍在（只读），自身 summary 仍含两条历史测次
  const sumOld = buildLineageSummary(parent, surveys, plantings, [adj]);
  assert(sumOld.points.length === 2, `老地块保留 2 条历史测次（实得 ${sumOld.points.length}）`);

  assert(replantGate(parent, [adj], surveys, plantings).allowed === false, '老地块只读不出补植');
  assert(replantGate(c1, [adj], surveys, plantings).allowed, '接平新区 c1 可出补植');
}

/* ---------- 场景 5：回填不出宗地（parcelCode 空）→ 只读不出补植 ---------- */
console.log('无宗地归属只读保留');
{
  const orphan = plot('orphan', 'normal', true, '');
  const gate = replantGate(orphan, [], [], []);
  assert(!gate.allowed && gate.readOnly, '回填不出宗地只读保留、不出补植', gate);
}

console.log(failures === 0 ? '\n全部断言通过 🎉' : `\n有 ${failures} 条断言失败`);
process.exit(failures === 0 ? 0 : 1);
