# 红树林修复地块成活率跟踪台（sologsb101-1014）

面向红树林修复项目的现场管理人员：按地块登记苗木批次与栽植记录，分次验收成活株数与株高，
按测次生成成活率趋势，低于阈值时生成补植计划并回写地块缺株数。
v3 起接入**林业站权属台账**：宗地编号、权属面积、四至与重划（并宗 / 分宗）通过挂接表与项目部
修复地块对接，自动核对面积与测次，对不上的先挂起复核、挂起期间不出补植计划。

**纯前端单页应用**：无后端、无数据库服务、无 API 调用，数据全部保存在浏览器本地（IndexedDB），
容器完全无状态、不挂载任何数据卷。

---

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env && docker compose up -d --build
```

启动后访问：**http://localhost:22814**

常用命令：

```bash
docker compose ps                  # 查看容器状态
docker compose logs -f frontend    # 查看 nginx 日志
docker compose down                # 停止并移除容器
docker compose up -d --build       # 改完代码后重新构建
```

> 端口可通过 `.env` 里的 `FRONTEND_PORT` 覆盖；容器名与镜像名前缀由 `COMPOSE_PROJECT_NAME` 控制。
> `docker-compose.yml` 顶层已写 `name: gbmangrove` 兜底，因此在任意目录名（含中文）下
> `docker compose config --quiet` 都不会报错。

---

## 二、技术栈

| 分层 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | React 18 | 函数组件 + Hooks |
| 语言 | TypeScript 5 | `strict` 模式，`tsc --noEmit` 零错误 |
| UI 组件库 | Ant Design 5 | 表格、表单、弹窗、日期选择、消息提示 |
| 图标 | @ant-design/icons | |
| 构建 | Vite 5 | 开发端口与宿主端口一致（22814） |
| 路由 | React Router 6 | `createBrowserRouter` + 路由懒加载 |
| 状态管理 | Zustand 4 | 跨页状态集中在 store，页面只读 store |
| 本地持久化 | Dexie 4（IndexedDB） | 库名 `gbmangrove`，含 v1 → v2 → v3 升级迁移 |
| 时间处理 | dayjs | |
| 容器 | node:20-alpine → nginx:alpine | 多阶段构建，`chmod -R a+rX` 规避静态资源 403 |

---

## 三、目录结构

```
sologsb101-1014/
├── README.md
├── docker-compose.yml          # name: gbmangrove，不写 version 字段
├── .env / .env.example         # COMPOSE_PROJECT_NAME / FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf              # try_files $uri $uri/ /index.html; + gzip
    ├── .dockerignore
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── index.html
    ├── public/favicon.svg
    └── src/
        ├── main.tsx            # 入口：ConfigProvider + RouterProvider
        ├── App.tsx             # 外壳：侧边导航 + 当前地块上下文 + 数据库初始化
        ├── styles/main.css
        ├── types/              # plot.ts parcel.ts parcelLink.ts seedling.ts planting.ts survey.ts replant.ts
        ├── stores/             # plotStore.ts parcelStore.ts surveyStore.ts replantStore.ts
        ├── components/common/  # RateTag.tsx FilterBar.tsx StatBadge.tsx EmptyPanel.tsx
        ├── hooks/              # useSurvivalRate.ts useIdbTable.ts
        ├── pages/              # PlotList ParcelBoard SeedlingBoard PlantingEntry SurveyBoard ReplantPlan
        ├── router/index.tsx    # 路由表 + ROUTES 常量
        ├── scripts/            # v2→v3 迁移与对接口径验证（npm run verify:migration）
        └── utils/              # rate.ts parcel.ts db.ts export.ts seed.ts id.ts
```

---

## 四、路由与功能模块

| 路由 | 页面文件 | 功能 |
| --- | --- | --- |
| `/plots` | `pages/PlotList.tsx` | 修复地块台账：新建/编辑/级联删除、按潮位带与底质筛选、回显栽植总株数与最新成活率、权属对接状态 |
| `/parcels` | `pages/ParcelBoard.tsx` | 林业站权属宗地台账：宗地编号/权属面积/四至、并宗与分宗挂接、自动核对与挂起复核、跨宗成活率口径 |
| `/plots/:id/seedlings` | `pages/SeedlingBoard.tsx` | 苗木批次与来源登记、批次数量累计校验（含密度提示） |
| `/plots/:id/plantings` | `pages/PlantingEntry.tsx` | 栽植记录：录株距与株数、按面积与株距校验密度合理性 |
| `/surveys` | `pages/SurveyBoard.tsx` | 成活率与株高验收台：按测次录入、自动算成活率、低于阈值告警、批量调整成活率等级、分宗历史测次只读继承 |
| `/replants` | `pages/ReplantPlan.tsx` | 补植计划：状态流转（待补植→已补植→已复核）、行内草稿、JSON 导入导出、结构版本查看、挂起冻结 |

`/` 重定向到 `/plots`，未匹配路径统一回落到 `/plots`。
**层级路由支持直接深链**：把 `http://localhost:22814/plots/plot-donggang-3/seedlings` 直接粘贴到地址栏即可打开；
若 id 查不到，页面会给出「地块不存在或已被删除」的友好空态与返回入口，不会白屏。

---

## 五、数据存储说明

* **持久化方案**：IndexedDB，通过 Dexie 封装（`src/utils/db.ts`）。
* **数据库名**：`gbmangrove`。
* **数据结构版本**：`DB_SCHEMA_VERSION = 3`，`version(1)` 建立全部表，`version(2)` 补齐索引并执行 `.upgrade()` 迁移，
  `version(3)` 接入权属侧两张表并回填历史宗地：
  * v2：为 `plots` 增加 `updatedAt`、`surveys` 增加 `[plotId+round]` 复合索引、`plantings` 增加 `spacingM` 索引等；
    回填 `revision` / `createdAt` / `updatedAt`；为 `plots` 补齐 `missingCount`、`lastReplantDate` 回写字段；
    为 `surveys` 补齐 `grade`、`gradeManual` 字段（按 `survivalRate` 自动判定等级）。
  * v3：新增 `parcels`（林业站权属宗地：宗地编号 / 权属面积 / 四至 / 重划生效日期 / 挂起状态）与
    `parcelLinks`（宗地—地块挂接：一一对应 / 并宗来源 / 分宗母块 / 分宗子块）；为 `plots` 增加 `readonly`。
    **已有数据没有宗地归属，升级时按原地块编号回填历史宗地**（宗地编号沿用原地块 id，建 direct 一一对应），
    **回填不出的地块（编号或面积无效）置 `readonly` 只读保留**，历史栽植 / 验收可见但不可改、不出补植计划。
* **表结构**：

  | 表 | 主键 | 主要索引 |
  | --- | --- | --- |
  | `plots` | id | name, tideZone, substrate, restoreMode, state, createdAt, updatedAt |
  | `seedlings` | id | plotId, species, source, arrivalDate, quantity |
  | `plantings` | id | plotId, seedlingId, plantDate, spacingM |
  | `surveys` | id | plotId, [plotId+round], date, grade |
  | `replants` | id | plotId, planDate, state, species |
  | `parcels` | id | parcelCode, ownerName, status, effectiveDate |
  | `parcelLinks` | id | parcelId, plotId, linkType |

* **首屏演示数据**：`initDatabase()` 在打开数据库后检测 `plots` 表是否为空，为空则调用 `utils/seed.ts` 播种，
  幂等且只执行一次。播种链路为 **宗地 → 地块 → 苗木批次 → 栽植 → 验收 → 补植** 互相对接：
  * 4 宗权属宗地：并宗宗地（东港两老地块 → LD-DG-2025-017，面积对得上）、一一对应（西湾）、
    分宗宗地（北屿 B 区拆给两个班组，面积对得上）、挂起复核宗地（南洲嘴，面积偏差超容差）；
  * 6 个修复地块：并宗 2 个老地块 + 一一对应 1 个 + 分宗母块 1 个 + 分宗子块 2 个；
  * 6 个苗木批次、6 条栽植记录、10 条验收记录（并宗两老块测次对齐可跨宗相加；母块历史测次早于分宗生效日、
    子块各有分宗后新测次）、3 条补植计划（覆盖待补植 / 已复核与分宗子块）。
  * 固定 id 如 `plot-donggang-3`、`plot-beiyu-b-1`、`parcel-donggang-merged` 可直接用于深链验证。
* **其他本地数据**：`localStorage` 仅保存「最近选中的地块 id」这一界面偏好，不存业务数据。
* 删除地块会**级联清理**其下的苗木批次、栽植记录、验收记录、补植计划与宗地挂接边（同一 Dexie 事务内完成）；
  删除宗地只清理权属侧台账与挂接边，不动项目部地块、栽植与验收数据。
* **迁移验证**：`npm run verify:migration`（Node + fake-indexeddb）自动核对 v2→v3 回填、并宗 / 分宗口径与挂起冻结，共 18 项断言。

---

## 六、本地开发

```bash
cd frontend
npm install
npm run dev          # http://localhost:22814
```

其他命令：

```bash
npm run build        # tsc --noEmit && vite build（零错误）
npm run typecheck    # 仅做 TypeScript 类型检查
npm run preview      # 预览 dist 产物
```

---

## 七、核心业务规则

* **成活率** = 成活株数 ÷ 该地块栽植总株数 × 100%（`src/utils/rate.ts` 统一口径）。
* **并宗后成活率分母：按各老地块栽植总株数相加，不按权属面积加权。**
  成活率口径是「成活株数 / 实际栽植株数」，面积加权会把两宗立地密度差异塞进分母，
  且无法与历史测次的成活株数对应。同一测次跨宗相加：分母 = Σ 各老地块栽植总株数，分子 = Σ 同测次成活株数；
  某老地块缺该测次时该测次不硬凑，直接列入挂起复核。老地块编号与其栽植 / 验收记录原样保留。
* **分宗后历史验收测次：归分宗母块留档，两个子块只读继承展示。**
  历史测次不拆株数、不进任何子块的成活率分母；分宗生效日后的新测次录到具体班组子块，
  子块按自身栽植总株数独立算成活率、独立出补植计划。母块不再录新测次、不产生补植计划。
* **挂起复核（对不上的先挂起，挂起期间不出补植计划）**：权属面积与挂接地块面积合计偏差 > 2% 容差、
  并宗测次不齐、分宗缺母块或子块面积等情况自动列入问题清单；也可人工带原因挂起。
  挂起 / 只读 / 分宗母块 / 未挂宗地的地块，补植计划的生成与状态推进在界面与数据库层（`advanceReplantState`）双重冻结。
* **历史数据升级**：已有数据没有宗地归属，升级 v3 时按原地块编号回填历史宗地与 direct 挂接；
  回填不出的地块只读保留，不删数据、不阻断升级。
* **成活率等级**：≥ 85% 优，70%–85% 良，50%–70% 一般，< 50% 差；低于 50% 视为告警，建议生成补植计划。
* **密度合理性**：平均单株占地面积需落在 0.6–12 ㎡/株；过密/过疏都会在栽植记录页给出提示。
* **补植回写**：补植状态推进到「已补植」时，自动扣减地块缺株数、写入最近补植日期，
  并按「原成活株数 + 本次补植株数」重算最新一次验收的成活率。
