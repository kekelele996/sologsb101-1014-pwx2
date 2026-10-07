/**
 * /parcels 林业站权属台账
 * 两本账在这里与项目部对接：
 *   - 宗地：宗地编号 / 权属面积 / 四至（林业站口径，唯一权威）；
 *   - 重划：并宗（两宗→一宗）/ 分宗（一宗→两宗），保存即自动接平，
 *     对不上挂起复核，挂起期间相关地块不出补植计划。
 * 消费模型：Parcel、ParcelAdjustment、Plot；复用组件：<StatBadge>、<EmptyPanel>、<FilterBar>
 */
import { useMemo, useState } from 'react';
import {
  App,
  Button,
  Card,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  BlockOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  PullRequestOutlined,
} from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import EmptyPanel from '../components/common/EmptyPanel';
import StatBadge from '../components/common/StatBadge';
import { useParcelStore } from '../stores/parcelStore';
import { usePlotStore } from '../stores/plotStore';
import { PLOT_LINEAGE_ROLE_LABEL } from '../types/plot';
import {
  PARCEL_STATUS_LABEL,
  PARCEL_STATUS_OPTIONS,
  type Parcel,
  type ParcelDraft,
} from '../types/parcel';
import {
  ADJUSTMENT_MODE_LABEL,
  ADJUSTMENT_MODE_OPTIONS,
  HOLD_REASON_LABEL,
  type ParcelAdjustment,
  type ParcelAdjustmentDraft,
} from '../types/parcelAdjustment';

interface ParcelFormValues {
  parcelCode: string;
  areaMu: number;
  status: Parcel['status'];
  east: string;
  south: string;
  west: string;
  north: string;
}

interface AdjustmentFormValues {
  mode: ParcelAdjustment['mode'];
  effectiveDate: Dayjs;
  oldParcelA: string;
  oldParcelB?: string;
  newParcelA: string;
  newParcelB?: string;
  parentPlotA: string;
  parentPlotB?: string;
  successorPlotA: string;
  successorPlotB?: string;
  remark: string;
}

const DEFAULT_PARCEL: ParcelFormValues = {
  parcelCode: '',
  areaMu: 30,
  status: 'active',
  east: '',
  south: '',
  west: '',
  north: '',
};

export default function ParcelLedger() {
  const { message } = App.useApp();
  const parcels = useParcelStore((s) => s.parcels);
  const adjustments = useParcelStore((s) => s.adjustments);
  const ready = useParcelStore((s) => s.ready);
  const createParcel = useParcelStore((s) => s.createParcel);
  const updateParcel = useParcelStore((s) => s.updateParcel);
  const deleteParcel = useParcelStore((s) => s.deleteParcel);
  const saveAdjustment = useParcelStore((s) => s.saveAdjustment);
  const setAdjustmentHold = useParcelStore((s) => s.setAdjustmentHold);
  const deleteAdjustment = useParcelStore((s) => s.deleteAdjustment);

  const plots = usePlotStore((s) => s.plots);
  const plotName = (id: string): string => plots.find((p) => p.id === id)?.name ?? '（地块缺失）';
  const parcelArea = (code: string): number => parcels.find((p) => p.parcelCode === code)?.areaMu ?? 0;

  const [parcelOpen, setParcelOpen] = useState(false);
  const [editingParcel, setEditingParcel] = useState<Parcel | null>(null);
  const [adjOpen, setAdjOpen] = useState(false);
  const [parcelForm] = Form.useForm<ParcelFormValues>();
  const [adjForm] = Form.useForm<AdjustmentFormValues>();
  const mode = Form.useWatch('mode', adjForm) as ParcelAdjustment['mode'] | undefined;

  const activeCount = parcels.filter((p) => p.status === 'active').length;
  const holdCount = adjustments.filter((a) => a.linkState === 'hold').length;

  const parcelOptions = useMemo(
    () => parcels.map((p) => ({ value: p.parcelCode, label: `${p.parcelCode}（${p.areaMu} 亩）` })),
    [parcels],
  );
  const plotOptions = useMemo(() => plots.map((p) => ({ value: p.id, label: p.name })), [plots]);

  /* ------------------------------- 宗地表单 ------------------------------- */
  const openParcelCreate = () => {
    setEditingParcel(null);
    parcelForm.setFieldsValue(DEFAULT_PARCEL);
    setParcelOpen(true);
  };
  const openParcelEdit = (row: Parcel) => {
    setEditingParcel(row);
    parcelForm.setFieldsValue({
      parcelCode: row.parcelCode,
      areaMu: row.areaMu,
      status: row.status,
      east: row.boundaries.east,
      south: row.boundaries.south,
      west: row.boundaries.west,
      north: row.boundaries.north,
    });
    setParcelOpen(true);
  };
  const submitParcel = async () => {
    const v = await parcelForm.validateFields();
    const draft: ParcelDraft = {
      parcelCode: v.parcelCode.trim(),
      areaMu: v.areaMu,
      status: v.status,
      boundaries: { east: v.east.trim(), south: v.south.trim(), west: v.west.trim(), north: v.north.trim() },
    };
    if (editingParcel) {
      await updateParcel(editingParcel.id, draft);
      message.success('宗地台账已更新');
    } else {
      await createParcel(draft);
      message.success(`已登记宗地 ${draft.parcelCode}`);
    }
    setParcelOpen(false);
  };

  /* ------------------------------ 重划表单 ------------------------------ */
  const openAdjCreate = () => {
    adjForm.setFieldsValue({
      mode: 'merge',
      effectiveDate: dayjs(),
      remark: '',
    });
    setAdjOpen(true);
  };
  const submitAdjustment = async () => {
    const v = await adjForm.validateFields();
    const isMerge = v.mode === 'merge';
    const draft: ParcelAdjustmentDraft = {
      mode: v.mode,
      effectiveDate: v.effectiveDate.format('YYYY-MM-DD'),
      oldParcelCodes: isMerge ? [v.oldParcelA, v.oldParcelB ?? ''] : [v.oldParcelA],
      newParcelCodes: isMerge ? [v.newParcelA] : [v.newParcelA, v.newParcelB ?? ''],
      parentPlotIds: isMerge ? [v.parentPlotA, v.parentPlotB ?? ''] : [v.parentPlotA],
      successorPlotIds: isMerge ? [v.successorPlotA] : [v.successorPlotA, v.successorPlotB ?? ''],
      remark: v.remark,
    };
    const saved = await saveAdjustment(draft);
    if (saved.linkState === 'hold') {
      message.warning(`已保存并挂起复核：${HOLD_REASON_LABEL[saved.holdReason]}。挂起期间不出补植计划。`, 6);
    } else {
      message.success('重划记录已保存，两边台账已接平');
    }
    setAdjOpen(false);
  };

  const parcelColumns: ColumnsType<Parcel> = [
    {
      title: '宗地编号',
      dataIndex: 'parcelCode',
      key: 'parcelCode',
      width: 170,
      render: (value: string, row) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{value}</Typography.Text>
          {row.source === 'legacyBackfill' ? (
            <Typography.Text type="warning" style={{ fontSize: 12 }}>
              升级回填
            </Typography.Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: '权属面积（亩）',
      dataIndex: 'areaMu',
      key: 'areaMu',
      width: 130,
      align: 'right',
      sorter: (a, b) => a.areaMu - b.areaMu,
    },
    { title: '东至', key: 'east', width: 120, render: (_v, r) => r.boundaries.east || '—' },
    { title: '南至', key: 'south', width: 120, render: (_v, r) => r.boundaries.south || '—' },
    { title: '西至', key: 'west', width: 120, render: (_v, r) => r.boundaries.west || '—' },
    { title: '北至', key: 'north', width: 120, render: (_v, r) => r.boundaries.north || '—' },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 90,
      render: (value: Parcel['status']) => (
        <Tag color={value === 'active' ? 'green' : 'default'}>{PARCEL_STATUS_LABEL[value]}</Tag>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 150,
      render: (_v, row) => (
        <Space size={4}>
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openParcelEdit(row)}>
            编辑
          </Button>
          <Popconfirm
            title="删除该宗地？"
            description="已被重划记录引用的宗地删除后会导致接账挂起。"
            okText="删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={async () => {
              await deleteParcel(row.id);
              message.success('宗地已删除');
            }}
          >
            <Button size="small" type="link" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const codeTags = (codes: string[]) => (
    <Space size={4} wrap>
      {codes.map((code) => (
        <Tag key={code} color="geekblue">
          {code}
          <span style={{ marginLeft: 4, opacity: 0.7 }}>{parcelArea(code)} 亩</span>
        </Tag>
      ))}
    </Space>
  );

  const adjColumns: ColumnsType<ParcelAdjustment> = [
    {
      title: '方式',
      dataIndex: 'mode',
      key: 'mode',
      width: 90,
      render: (value: ParcelAdjustment['mode']) => (
        <Tag color={value === 'merge' ? 'purple' : 'magenta'} icon={<PullRequestOutlined />}>
          {ADJUSTMENT_MODE_LABEL[value]}
        </Tag>
      ),
    },
    { title: '生效日', dataIndex: 'effectiveDate', key: 'effectiveDate', width: 110 },
    {
      title: '老宗地（林业站）',
      key: 'old',
      width: 260,
      render: (_v, r) => codeTags(r.oldParcelCodes),
    },
    {
      title: '新宗地（林业站）',
      key: 'new',
      width: 260,
      render: (_v, r) => codeTags(r.newParcelCodes),
    },
    {
      title: '项目部老地块',
      key: 'parents',
      width: 220,
      render: (_v, r) => (
        <Space direction="vertical" size={0}>
          {r.parentPlotIds.map((id) => (
            <Typography.Text key={id} style={{ fontSize: 12 }}>
              {plotName(id)}
            </Typography.Text>
          ))}
        </Space>
      ),
    },
    {
      title: '承接地块',
      key: 'successors',
      width: 200,
      render: (_v, r) => (
        <Space direction="vertical" size={0}>
          {r.successorPlotIds.map((id) => (
            <Typography.Text key={id} style={{ fontSize: 12 }}>
              {plotName(id)}（{PLOT_LINEAGE_ROLE_LABEL[r.mode === 'merge' ? 'mergeTarget' : 'splitChild']}）
            </Typography.Text>
          ))}
        </Space>
      ),
    },
    {
      title: '接账状态',
      key: 'link',
      width: 220,
      render: (_v, r) =>
        r.linkState === 'linked' ? (
          <Tag color="success">已接平</Tag>
        ) : (
          <Space direction="vertical" size={2}>
            <Tag color="error">挂起复核</Tag>
            <Typography.Text type="danger" style={{ fontSize: 12 }}>
              {HOLD_REASON_LABEL[r.holdReason]}
            </Typography.Text>
            {r.heldRounds.length > 0 ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                挂起测次：{r.heldRounds.map((n) => `第${n}次`).join('、')}
              </Typography.Text>
            ) : null}
          </Space>
        ),
    },
    {
      title: '操作',
      key: 'action',
      width: 210,
      fixed: 'right',
      render: (_v, r) => (
        <Space size={4} wrap>
          {r.linkState === 'hold' ? (
            <Button size="small" type="link" onClick={async () => {
              await setAdjustmentHold(r.id, false);
              message.success('已标记复核通过（接平）');
            }}>
              复核通过
            </Button>
          ) : (
            <Button size="small" type="link" onClick={async () => {
              await setAdjustmentHold(r.id, true);
              message.warning('已人工挂起，挂起期间不出补植计划');
            }}>
              挂起
            </Button>
          )}
          <Popconfirm
            title="删除该重划记录？"
            description="地块谱系角色需人工再核对，历史栽植/验收不会被删除。"
            okText="删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={async () => {
              await deleteAdjustment(r.id);
              message.success('重划记录已删除');
            }}
          >
            <Button size="small" type="link" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const isMerge = mode !== 'split';

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <StatBadge label="宗地总数" value={parcels.length} suffix="宗" tone="primary" icon={<BlockOutlined />} />
        <StatBadge label="现行宗地" value={activeCount} suffix="宗" tone="success" />
        <StatBadge label="重划记录" value={adjustments.length} suffix="条" tone="info" />
        <StatBadge
          label="挂起复核"
          value={holdCount}
          suffix="条"
          tone={holdCount > 0 ? 'danger' : 'default'}
          hint="挂起期间相关地块不出补植计划"
        />
      </div>

      <Tabs
        defaultActiveKey="parcels"
        items={[
          {
            key: 'parcels',
            label: '权属宗地',
            children: (
              <Card
                title="林业站权属台账 · 宗地"
                extra={<Button type="primary" icon={<PlusOutlined />} onClick={openParcelCreate}>登记宗地</Button>}
              >
                {parcels.length === 0 && ready ? (
                  <EmptyPanel
                    title="还没有宗地台账"
                    description="先按林业站口径登记宗地编号、权属面积与四至，再把项目部修复地块关联到现行宗地。"
                    actionText="登记第一宗"
                    onAction={openParcelCreate}
                  />
                ) : (
                  <Table<Parcel>
                    rowKey="id"
                    size="middle"
                    loading={!ready}
                    columns={parcelColumns}
                    dataSource={parcels}
                    scroll={{ x: 1080 }}
                    pagination={{ pageSize: 8, showSizeChanger: false }}
                  />
                )}
              </Card>
            ),
          },
          {
            key: 'adjustments',
            label: '并宗 / 分宗',
            children: (
              <Card
                title="宗地重划接账"
                extra={<Button type="primary" icon={<PlusOutlined />} onClick={openAdjCreate}>新建重划</Button>}
              >
                {adjustments.length === 0 && ready ? (
                  <EmptyPanel
                    title="还没有重划记录"
                    description="相邻两宗并成一宗、或一大宗拆成两宗时在此登记，保存即自动校验接平，对不上挂起复核。"
                    actionText="新建第一条重划"
                    onAction={openAdjCreate}
                  />
                ) : (
                  <Table<ParcelAdjustment>
                    rowKey="id"
                    size="middle"
                    loading={!ready}
                    columns={adjColumns}
                    dataSource={adjustments}
                    scroll={{ x: 1560 }}
                    pagination={{ pageSize: 8, showSizeChanger: false }}
                  />
                )}
              </Card>
            ),
          },
        ]}
      />

      {/* 宗地表单 */}
      <Modal
        title={editingParcel ? `编辑宗地 · ${editingParcel.parcelCode}` : '登记权属宗地'}
        open={parcelOpen}
        onCancel={() => setParcelOpen(false)}
        onOk={() => void submitParcel()}
        okText="保存"
        cancelText="取消"
      >
        <Form form={parcelForm} layout="vertical" initialValues={DEFAULT_PARCEL}>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="parcelCode" label="宗地编号" style={{ flex: 2 }} rules={[{ required: true, message: '请填写宗地编号' }]}>
              <Input placeholder="如：GBM-2025-101" />
            </Form.Item>
            <Form.Item name="areaMu" label="权属面积（亩）" style={{ flex: 1 }} rules={[{ required: true }]}>
              <InputNumber min={0.01} max={9999} step={0.5} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="status" label="状态" style={{ flex: 1 }} rules={[{ required: true }]}>
              <Select options={PARCEL_STATUS_OPTIONS.map((v) => ({ value: v, label: PARCEL_STATUS_LABEL[v] }))} />
            </Form.Item>
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
            四至按林业站权属台账界址说明填写（历史回填宗地可留空，后续补登）。
          </Typography.Text>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="east" label="东至" style={{ flex: 1 }}><Input /></Form.Item>
            <Form.Item name="south" label="南至" style={{ flex: 1 }}><Input /></Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="west" label="西至" style={{ flex: 1 }}><Input /></Form.Item>
            <Form.Item name="north" label="北至" style={{ flex: 1 }}><Input /></Form.Item>
          </Space>
        </Form>
      </Modal>

      {/* 重划表单 */}
      <Modal
        title="新建宗地重划（并宗 / 分宗）"
        open={adjOpen}
        onCancel={() => setAdjOpen(false)}
        onOk={() => void submitAdjustment()}
        okText="保存并接平"
        cancelText="取消"
        width={720}
      >
        <Form form={adjForm} layout="vertical">
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="mode" label="重划方式" style={{ flex: 1 }} rules={[{ required: true }]}>
              <Select options={ADJUSTMENT_MODE_OPTIONS.map((v) => ({ value: v, label: ADJUSTMENT_MODE_LABEL[v] }))} />
            </Form.Item>
            <Form.Item name="effectiveDate" label="生效日期" style={{ flex: 1 }} rules={[{ required: true }]}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
          </Space>

          <Card size="small" title={isMerge ? '并宗：两宗 → 一宗' : '分宗：一宗 → 两宗'} style={{ marginBottom: 12 }}>
            <Space size={8} style={{ display: 'flex' }} align="end">
              <Form.Item name="oldParcelA" label={isMerge ? '老宗地①' : '老宗地'} style={{ flex: 1 }} rules={[{ required: true }]}>
                <Select showSearch options={parcelOptions} placeholder="宗地编号" />
              </Form.Item>
              {isMerge ? (
                <Form.Item name="oldParcelB" label="老宗地②" style={{ flex: 1 }} rules={[{ required: true }]}>
                  <Select showSearch options={parcelOptions} placeholder="宗地编号" />
                </Form.Item>
              ) : null}
            </Space>
            <Space size={8} style={{ display: 'flex' }} align="end">
              <Form.Item name="newParcelA" label={isMerge ? '并后新宗地' : '新宗地①'} style={{ flex: 1 }} rules={[{ required: true }]}>
                <Select showSearch options={parcelOptions} placeholder="宗地编号" />
              </Form.Item>
              {!isMerge ? (
                <Form.Item name="newParcelB" label="新宗地②" style={{ flex: 1 }} rules={[{ required: true }]}>
                  <Select showSearch options={parcelOptions} placeholder="宗地编号" />
                </Form.Item>
              ) : null}
            </Space>
          </Card>

          <Card size="small" title="对应到项目部修复地块" style={{ marginBottom: 12 }}>
            <Space size={8} style={{ display: 'flex' }} align="end">
              <Form.Item name="parentPlotA" label={isMerge ? '老地块①（历史只读）' : '老地块（历史只读）'} style={{ flex: 1 }} rules={[{ required: true }]}>
                <Select showSearch options={plotOptions} />
              </Form.Item>
              {isMerge ? (
                <Form.Item name="parentPlotB" label="老地块②（历史只读）" style={{ flex: 1 }} rules={[{ required: true }]}>
                  <Select showSearch options={plotOptions} />
                </Form.Item>
              ) : null}
            </Space>
            <Space size={8} style={{ display: 'flex' }} align="end">
              <Form.Item name="successorPlotA" label={isMerge ? '并后承接地块' : '新地块①（班组一）'} style={{ flex: 1 }} rules={[{ required: true }]}>
                <Select showSearch options={plotOptions} />
              </Form.Item>
              {!isMerge ? (
                <Form.Item name="successorPlotB" label="新地块②（班组二）" style={{ flex: 1 }} rules={[{ required: true }]}>
                  <Select showSearch options={plotOptions} />
                </Form.Item>
              ) : null}
            </Space>
          </Card>

          <Form.Item name="remark" label="备注（班组划分 / 说明）">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            保存时自动接平：并宗成活率分母按各老地块栽植总株数相加、同测次同日期对齐成活株数；
            分宗历史测次保留在老地块只读，新区自生效日各自重新起测。对不上即挂起，挂起期间不出补植计划。
          </Typography.Text>
        </Form>
      </Modal>
    </div>
  );
}
