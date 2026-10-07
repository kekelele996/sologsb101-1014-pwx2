/**
 * 迁移与对接口径验证脚本（Node + fake-indexeddb，不进构建产物）
 * 先运行：npx esbuild scripts/app-exports.ts --bundle --platform=node --format=esm --outfile=scripts/app-bundle.mjs
 */
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

// 必须在 import app 包之前注入：Dexie 在模块初始化时读取 indexedDB / IDBKeyRange
globalThis.indexedDB = new IDBFactory();
globalThis.IDBKeyRange = IDBKeyRange;

const mod = await import('./app-bundle.mjs');
const { db, initDatabase, advanceReplantState, DB_SCHEMA_VERSION } = mod;
const {
  buildMergeRounds,
  inheritedSurveys,
  isSplitParentPlot,
  replantBlockReason,
} = mod.parcelUtil;

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failures += 1;
    console.error(`  ❌ ${name} ${detail}`);
  }
}

/** 以 v2 结构建老库并灌入无宗地归属的历史数据 */
function seedV2() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('gbmangrove', 2);
    req.onupgradeneeded = () => {
      const dbi = req.result;
      const plots = dbi.createObjectStore('plots', { keyPath: 'id' });
      plots.createIndex('name', 'name');
      dbi.createObjectStore('seedlings', { keyPath: 'id' });
      const plantings = dbi.createObjectStore('plantings', { keyPath: 'id' });
      plantings.createIndex('plotId', 'plotId');
      const surveys = dbi.createObjectStore('surveys', { keyPath: 'id' });
      surveys.createIndex('plotId', 'plotId');
      dbi.createObjectStore('replants', { keyPath: 'id' });
    };
    req.onsuccess = () => {
      const dbv2 = req.result;
      const tx = dbv2.transaction(['plots', 'seedlings', 'plantings', 'surveys', 'replants'], 'readwrite');
      tx.objectStore('plots').put({ id: 'plot-old-1', name: '老地块一', areaMu: 20 });
      tx.objectStore('plots').put({ id: 'plot-old-2', name: '老地块二', areaMu: 30 });
      tx.objectStore('plots').put({ id: 'plot-bad', name: '残缺地块', areaMu: 0 });
      tx.objectStore('plantings').put({ id: 'p1', plotId: 'plot-old-1', count: 1000 });
      tx.objectStore('plantings').put({ id: 'p2', plotId: 'plot-old-2', count: 2000 });
      tx.objectStore('surveys').put({ id: 's1', plotId: 'plot-old-1', round: 1, aliveCount: 900, survivalRate: 90, grade: 'excellent', gradeManual: false });
      tx.objectStore('surveys').put({ id: 's2', plotId: 'plot-old-2', round: 1, aliveCount: 1500, survivalRate: 75, grade: 'good', gradeManual: false });
      tx.objectStore('replants').put({ id: 'r1', plotId: 'plot-bad', missingCount: 10, state: '待补植', species: '秋茄', planDate: '2025-01-01' });
      tx.oncomplete = () => {
        dbv2.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}

await seedV2();

console.log('1) v2 → v3 升级：按原地块编号回填历史宗地');
await initDatabase();
const parcels = await db.parcels.toArray();
const links = await db.parcelLinks.toArray();
const plots = await db.plots.toArray();
check('回填出 2 宗历史宗地', parcels.length === 2, `实际 ${parcels.length}`);
const codeSet = new Set(parcels.map((p) => p.parcelCode));
check('宗地编号沿用原地块编号', codeSet.has('plot-old-1') && codeSet.has('plot-old-2'));
check('回填来源标记为 upgrade-backfill', parcels.every((p) => p.source === 'upgrade-backfill'));
check('建了 2 条 direct 挂接', links.length === 2 && links.every((l) => l.linkType === 'direct'), `实际 ${links.length}`);
const bad = plots.find((p) => p.id === 'plot-bad');
check('回填不出的地块置只读保留', bad?.readonly === true);
check('只读地块没有宗地挂接', links.every((l) => l.plotId !== 'plot-bad'));
check('结构版本为 v3', DB_SCHEMA_VERSION === 3, `实际 ${DB_SCHEMA_VERSION}`);

console.log('2) 并宗口径：分母按老地块栽植总株数相加');
const plantings = await db.plantings.toArray();
const surveys = await db.surveys.toArray();
const { rounds } = buildMergeRounds(['plot-old-1', 'plot-old-2'], surveys, plantings);
check('聚合出 1 个测次', rounds.length === 1);
check('分母 = 1000 + 2000 = 3000（株数相加，非面积加权）', rounds[0].totalCount === 3000, `实际 ${rounds[0].totalCount}`);
check('成活株数同测次相加 = 900 + 1500 = 2400', rounds[0].aliveCount === 2400, `实际 ${rounds[0].aliveCount}`);
check('并宗成活率 = 80%', rounds[0].rate === 80, `实际 ${rounds[0].rate}`);

console.log('3) 缺测次 → 自动发现对不上问题');
const { missingRoundPlots } = buildMergeRounds(
  ['plot-old-1', 'plot-old-2'],
  surveys.filter((s) => s.plotId !== 'plot-old-2'),
  plantings,
);
check('缺第 2 宗该测次被识别', missingRoundPlots.length === 1 && missingRoundPlots[0] === 'plot-old-2');

console.log('4) 分宗：历史测次留母块、子块只读继承');
const stamp = new Date().toISOString();
await db.transaction('rw', [db.plots, db.surveys, db.parcels, db.parcelLinks], async () => {
  await db.plots.bulkPut([
    { id: 'mom', name: '母块', areaMu: 40, missingCount: 0, lastReplantDate: '', state: '跟踪中', createdAt: stamp, updatedAt: stamp, revision: 3 },
    { id: 'kid-1', name: '子块一', areaMu: 20, missingCount: 0, lastReplantDate: '', state: '跟踪中', createdAt: stamp, updatedAt: stamp, revision: 3 },
  ]);
  await db.parcels.put({ id: 'pc-split', parcelCode: 'SP-1', ownerName: 'x', areaMu: 40, boundaries: '', effectiveDate: '2025-06-01', status: '正常', holdReason: '', source: 'manual', createdAt: stamp, updatedAt: stamp, revision: 3 });
  await db.parcelLinks.bulkPut([
    { id: 'l-mom', parcelId: 'pc-split', plotId: 'mom', linkType: 'split-parent', team: '', splitAreaMu: 0, createdAt: stamp, updatedAt: stamp, revision: 3 },
    { id: 'l-kid', parcelId: 'pc-split', plotId: 'kid-1', linkType: 'split-child', team: '甲班', splitAreaMu: 20, createdAt: stamp, updatedAt: stamp, revision: 3 },
  ]);
  await db.surveys.put({ id: 'ms1', plotId: 'mom', round: 1, date: '2025-03-01', aliveCount: 100, avgHeightCm: 50, survivalRate: 90, grade: 'excellent', gradeManual: false, createdAt: stamp, updatedAt: stamp, revision: 3 });
});
const allLinks = await db.parcelLinks.toArray();
const allSurveys = await db.surveys.toArray();
const inherited = inheritedSurveys('kid-1', allLinks, allSurveys, '2025-06-01');
check('子块继承母块 1 个历史测次', inherited.length === 1 && inherited[0].survey.id === 'ms1');
check('母块被识别为 split-parent', isSplitParentPlot('mom', allLinks) === true);
const momPlot = await db.plots.get('mom');
const allParcels = await db.parcels.toArray();
check('分宗母块冻结补植', replantBlockReason(momPlot, allParcels, allLinks) === 'split-parent');

console.log('5) 挂起期间不出补植计划（硬防线）');
await db.transaction('rw', [db.plots, db.replants], async () => {
  await db.plots.put({ id: 'plot-old-1', name: '老地块一', areaMu: 20, missingCount: 0, lastReplantDate: '', state: '跟踪中', createdAt: stamp, updatedAt: stamp, revision: 3 });
  await db.replants.put({ id: 'r-hold', plotId: 'plot-old-1', missingCount: 5, state: '待补植', species: '秋茄', planDate: '2025-01-01', createdAt: stamp, updatedAt: stamp, revision: 3 });
});
const histParcel = await db.parcels.get('parcel-hist-plot-old-1');
await db.parcels.put({ ...histParcel, status: '挂起复核', holdReason: '测试挂起' });
await advanceReplantState('r-hold', '已补植');
const after = await db.replants.get('r-hold');
check('挂起时推进被拦截，状态仍是待补植', after.state === '待补植', `实际 ${after.state}`);
await db.parcels.put({ ...histParcel, status: '正常', holdReason: '' });
await advanceReplantState('r-hold', '已补植');
const after2 = await db.replants.get('r-hold');
check('复核通过后可推进为已补植', after2.state === '已补植', `实际 ${after2.state}`);

console.log('6) 只读地块冻结补植');
check('只读地块冻结原因 = readonly', replantBlockReason(bad, await db.parcels.toArray(), allLinks) === 'readonly');

db.close();
if (failures > 0) {
  console.error(`\n${failures} 项验证失败`);
  process.exit(1);
}
console.log('\n全部迁移与对接口径验证通过 ✅');
