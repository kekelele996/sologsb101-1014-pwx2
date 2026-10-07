/**
 * /parcels 林业站权属宗地台账
 * 管宗地编号、权属面积、四至与重划生效日期；挂接项目部修复地块（一一对应 / 并宗来源 / 分宗母子）。
 * 自动核对面积与测次：对不上的挂起复核；并宗成活率按老地块栽植总株数相加口径展示。
 * 消费模型：Parcel、ParcelLink、Plot、Planting、Survey。
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  DatePicker,
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Timeline,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  DeleteOutlined,
  EditOutlined,
  LinkOutlined,
  PlusOutlined,
  SafetyCertificateOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import EmptyPanel from '../components/common/EmptyPanel';
import RateTag from '../components/common/RateTag';
import StatBadge from '../components/common/StatBadge';
import { useParcelStore } from '../stores/parcelStore';
import { PARCEL_STATUS_OPTIONS, type Parcel, type ParcelDraft } from '../types/parcel';
import {
  PARCEL_LINK_TYPE_LABEL,
  PARCEL_LINK_TYPE_OPTIONS,
  type ParcelLink,
  type ParcelLinkDraft,
  type ParcelLinkType,
} from '../types/parcelLink';
import { buildMergeRounds, plotPlantedTotal, type ParcelView } from '../utils/parcel';

interface ParcelFormValues {
  parcelCode: string;
  ownerName: string;
  areaMu: number;
  boundaries: string;
  effectiveDate: Dayjs;
}

const SHAPE_LABEL: Record<ParcelView['shape'], { text: string; color: string }> = {
  direct: { text: '一一对应', color: 'green' },
  merge: { text: '并宗', color: 'geekblue' },
  split: { text: '分宗', color: 'purple' },
  orphan: { text: '未挂接', color: 'default' },
};

export default function ParcelBoard() {
  const { message } = App.useApp();
  const parcels = useParcelStore((state) => state.parcels);
  const links = useParcelStore((state) => state.links);
  const plots = useParcelStore((state) => state.plots);
  const plantings = useParcelStore((state) => state.plantings);
  const surveys = useParcelStore((state) => state.surveys);
  const ready = useParcelStore((state) => state.ready);
  const loadAll = useParcelStore((state) => state.loadAll);
  const createParcel = useParcelStore((state) => state.createParcel);
  const updateParcel = useParcelStore((state) => state.updateParcel);
  const deleteParcel = useParcelStore((state) => state.deleteParcel);
  const holdParcel = useParcelStore((state) => state.holdParcel);
  const releaseParcel = useParcelStore((state) => state.releaseParcel);
  const createLink = useParcelStore((state) => state.createLink);
  const deleteLink = useParcelStore((state) => state.deleteLink);
  const viewOf = useParcelStore((state) => state.viewOf);
  const issuesOf = useParcelStore((state) => state.issuesOf);

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Parcel | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [linkParcel, setLinkParcel] = useState<Parcel | null>(null);
  const [holdTarget, setHoldTarget] = useState<Parcel | null>(null);
  const [form] = Form.useForm<ParcelFormValues>();
  const [linkForm] = Form.useForm<ParcelLinkDraft>();
  const [holdForm] = Form.useForm<{ holdReason: string }>();

  useMemo(() => {
    void loadAll();
  }, [loadAll]);

  const plotName = (plotId: string): string => plots.find((item) => item.id === plotId)?.name ?? '（地块已删除）';

  const stats = useMemo(() => {
    const held = parcels.filter((item) => item.status === '挂起复核').length;
    const autoIssue = parcels.filter((item) => issuesOf(item.id).length > 0).length;
    const merge = parcels.filter((item) => viewOf(item.id).shape === 'merge').length;
    const split = parcels.filter((item) => viewOf(item.id).shape === 'split').length;
    return { held, autoIssue, merge, split };
  }, [parcels, issuesOf, viewOf]);

  const openCreate = (): void => {
    setEditing(null);
    form.setFieldsValue({
      parcelCode: '',
      ownerName: '',
      areaMu: 30,
      boundaries: '',
      effectiveDate: dayjs(),
    });
    setOpen(true);
  };

  const openEdit = (parcel: Parcel): void => {
    setEditing(parcel);
    form.setFieldsValue({
      parcelCode: parcel.parcelCode,
      ownerName: parcel.ownerName,
      areaMu: parcel.areaMu,
      boundaries: parcel.boundaries,
      effectiveDate: parcel.effectiveDate === '' ? dayjs() : dayjs(parcel.effectiveDate),
    });
    setOpen(true);
  };

  const handleSubmit = async (): Promise<void> => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      const draft: ParcelDraft = {
        parcelCode: values.parcelCode,
        ownerName: values.ownerName,
        areaMu: values.areaMu,
        boundaries: values.boundaries,
        effectiveDate: values.effectiveDate.format('YYYY-MM-DD'),
      };
      if (editing === null) {
        const row = await createParcel(draft);
        message.success(`已登记宗地「${row.parcelCode}」，请在右侧抽屉挂接修复地块`);
        setOpen(false);
        setLinkParcel(row);
        linkForm.setFieldsValue({ parcelId: row.id, plotId: plots[0]?.id ?? '', linkType: 'direct', team: '', splitAreaMu: 0 });
      } else {
        await updateParcel(editing.id, draft);
        message.success('宗地台账已更新');
        setOpen(false);
      }
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    } finally {
      setSubmitting(false);
    }
  };

  const openHold = (parcel: Parcel): void => {
    setHoldTarget(parcel);
    holdForm.setFieldsValue({ holdReason: parcel.holdReason });
  };

  const handleHold = async (): Promise<void> => {
    if (holdTarget === null) return;
    const values = await holdForm.validateFields();
    await holdParcel(holdTarget.id, values.holdReason);
    message.warning(`宗地「${holdTarget.parcelCode}」已挂起复核，挂起期间该宗地关联地块不出补植计划`);
    setHoldTarget(null);
  };

  const handleRelease = async (parcel: Parcel): Promise<void> => {
    const issues = issuesOf(parcel.id);
    if (issues.length > 0) {
      message.error(`自动核对仍有 ${issues.length} 项对不上，暂不能解除挂起，请先处理挂接关系`);
      return;
    }
    await releaseParcel(parcel.id);
    message.success(`宗地「${parcel.parcelCode}」复核通过，已解除挂起`);
  };

  const handleCreateLink = async (): Promise<void> => {
    if (linkParcel === null) return;
    const values = await linkForm.validateFields();
    await createLink({ ...values, parcelId: linkParcel.id });
    message.success(`已挂接「${plotName(values.plotId)}」（${PARCEL_LINK_TYPE_LABEL[values.linkType]}）`);
    linkForm.setFieldsValue({ plotId: undefined, linkType: 'direct', team: '', splitAreaMu: 0 });
  };

  /** 并宗口径预览：分母 = 各老地块栽植总株数相加 */
  const renderMergeRounds = (_parcel: Parcel, view: ParcelView) => {
    const { rounds, missingRoundPlots } = buildMergeRounds(view.scopePlotIds, surveys, plantings);
    const plantedSum = view.scopePlotIds.reduce((acc, id) => acc + plotPlantedTotal(id, plantings), 0);
    return (
      <Space direction="vertical" size={6} style={{ width: '100%' }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          并宗成活率分母 = 两个老地块栽植总株数相加（合计 {plantedSum.toLocaleString('zh-CN')} 株，不按权属面积加权）
        </Typography.Text>
        {rounds.map((item) => (
          <Space key={item.round} size={8} wrap>
            <Tag color="blue">第 {item.round} 测次</Tag>
            <span style={{ fontSize: 12 }}>
              成活 {item.aliveCount.toLocaleString('zh-CN')} / {item.totalCount.toLocaleString('zh-CN')} 株
            </span>
            <RateTag rate={item.rate} size="small" />
            {item.plotIds.length < view.scopePlotIds.length ? (
              <Tag icon={<WarningOutlined />} color="warning">
                缺 {view.scopePlotIds.length - item.plotIds.length} 宗该测次，已挂起复核
              </Tag>
            ) : null}
          </Space>
        ))}
        {missingRoundPlots.length > 0 ? (
          <Typography.Text type="warning" style={{ fontSize: 12 }}>
            测次不齐的老地块：{missingRoundPlots.map(plotName).join('、')}
          </Typography.Text>
        ) : null}
      </Space>
    );
  };

  /** 分宗口径预览：历史测次留母块，子块独立新测次 */
  const renderSplitDetail = (_parcel: Parcel, view: ParcelView) => (
    <Space direction="vertical" size={6} style={{ width: '100%' }}>
      {view.splitParentPlot !== null ? (
        <Typography.Text style={{ fontSize: 12 }}>
          分宗母块「{view.splitParentPlot.name}」保留历史验收{' '}
          {surveys.filter((row) => row.plotId === view.splitParentPlot?.id).length} 个测次（只读留档，两侧子块继承展示、不拆株数）
        </Typography.Text>
      ) : null}
      {view.childLinks.map((link) => {
        const childRounds = surveys.filter((row) => row.plotId === link.plotId).length;
        return (
          <Space key={link.id} size={8} wrap>
            <Tag color="purple">{link.team !== '' ? link.team : '未指定班组'}</Tag>
            <span style={{ fontSize: 12 }}>
              {plotName(link.plotId)} · 分宗面积 {link.splitAreaMu} 亩 · 分宗后新测次 {childRounds} 次
            </span>
          </Space>
        );
      })}
    </Space>
  );

  const columns: ColumnsType<Parcel> = [
    {
      title: '宗地编号',
      dataIndex: 'parcelCode',
      key: 'parcelCode',
      width: 170,
      render: (value: string, record) => (
        <Space direction="vertical" size={0}>
          <Typography.Link onClick={() => setLinkParcel(record)}>{value}</Typography.Link>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {record.ownerName}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '权属面积（亩）',
      dataIndex: 'areaMu',
      key: 'areaMu',
      width: 120,
      align: 'right',
      render: (value: number, record) => {
        const view = viewOf(record.id);
        const diff = view.linkedAreaSum > 0 ? Math.abs(value - view.linkedAreaSum) : 0;
        return (
          <Space direction="vertical" size={0}>
            <span>{value}</span>
            {view.linkedAreaSum > 0 ? (
              <Typography.Text type={diff / value > 0.02 ? 'danger' : 'secondary'} style={{ fontSize: 12 }}>
                地块侧合计 {view.linkedAreaSum}
              </Typography.Text>
            ) : null}
          </Space>
        );
      },
    },
    {
      title: '重划生效',
      dataIndex: 'effectiveDate',
      key: 'effectiveDate',
      width: 110,
      render: (value: string) => value || '—',
    },
    {
      title: '挂接形态',
      key: 'shape',
      width: 100,
      render: (_value, record) => {
        const shape = viewOf(record.id).shape;
        return <Tag color={SHAPE_LABEL[shape].color}>{SHAPE_LABEL[shape].text}</Tag>;
      },
    },
    {
      title: '挂接地块',
      key: 'plots',
      render: (_value, record) => {
        const view = viewOf(record.id);
        const names = view.scopePlotIds.map(plotName);
        if (names.length === 0) return <Typography.Text type="secondary">尚未挂接</Typography.Text>;
        return (
          <Space size={4} wrap>
            {names.map((name) => (
              <Tag key={name}>{name}</Tag>
            ))}
          </Space>
        );
      },
    },
    {
      title: '状态',
      key: 'status',
      width: 110,
      render: (_value, record) =>
        record.status === '挂起复核' ? (
          <Tag icon={<WarningOutlined />} color="error">
            挂起复核
          </Tag>
        ) : (
          <Tag icon={<SafetyCertificateOutlined />} color="success">
            正常
          </Tag>
        ),
    },
    {
      title: '操作',
      key: 'action',
      width: 300,
      fixed: 'right',
      render: (_value, record) => (
        <Space size={4} wrap>
          <Button size="small" type="link" icon={<LinkOutlined />} onClick={() => setLinkParcel(record)}>
            挂接 / 口径
          </Button>
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEdit(record)}>
            编辑
          </Button>
          {record.status === '挂起复核' ? (
            <Button size="small" type="link" onClick={() => void handleRelease(record)}>
              复核通过
            </Button>
          ) : (
            <Button size="small" type="link" danger icon={<WarningOutlined />} onClick={() => openHold(record)}>
              挂起
            </Button>
          )}
          <Popconfirm
            title="确认删除该宗地？"
            description="只删除林业站台账侧宗地与其挂接边，项目部地块、栽植与验收数据不会被删除。"
            okText="删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={async () => {
              await deleteParcel(record.id);
              message.success('宗地及其挂接关系已删除');
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

  const drawerLinks = linkParcel === null ? [] : links.filter((item) => item.parcelId === linkParcel.id);
  const drawerView = linkParcel === null ? null : viewOf(linkParcel.id);
  const drawerIssues = linkParcel === null ? [] : issuesOf(linkParcel.id);

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <StatBadge label="权属宗地" value={parcels.length} suffix="宗" tone="primary" icon={<SafetyCertificateOutlined />} />
        <StatBadge label="并宗宗地" value={stats.merge} suffix="宗" tone="info" />
        <StatBadge label="分宗宗地" value={stats.split} suffix="宗" tone="info" />
        <StatBadge
          label="挂起复核"
          value={stats.held}
          suffix="宗"
          tone={stats.held > 0 ? 'danger' : 'default'}
          hint="挂起期间关联地块不出补植计划"
        />
        <StatBadge
          label="自动核对异常"
          value={stats.autoIssue}
          suffix="宗"
          tone={stats.autoIssue > 0 ? 'warning' : 'default'}
          hint="面积偏差超 2% 容差、并宗测次不齐等"
        />
      </div>

      <Card
        title="林业站权属宗地台账"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            登记宗地
          </Button>
        }
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 12 }}>
          林业站侧管宗地编号、权属面积、四至与重划生效日期；项目部侧管修复地块及其下栽植记录、验收测次。
          两边通过挂接关系对接：相邻两宗并成一宗时，老地块编号保留、成活率分母按各老地块栽植总株数相加；
          大地块拆成两宗时，历史验收测次留分宗母块、两侧子块只读继承，新测次各自独立。对不上的先挂起复核，挂起期间不出补植计划。
        </Typography.Paragraph>

        {ready && parcels.length === 0 ? (
          <EmptyPanel
            title="还没有权属宗地"
            description="先按林业站重划后的台账登记宗地编号、权属面积与四至，再挂接对应的修复地块。"
            actionText="登记第一宗"
            onAction={openCreate}
          />
        ) : (
          <Table<Parcel>
            rowKey="id"
            size="middle"
            loading={!ready}
            columns={columns}
            dataSource={parcels}
            scroll={{ x: 1300 }}
            pagination={{ pageSize: 8, showSizeChanger: false }}
            expandable={{
              expandedRowRender: (record) => {
                const view = viewOf(record.id);
                const issueList = issuesOf(record.id);
                return (
                  <Space direction="vertical" size={8} style={{ width: '100%' }}>
                    {record.boundaries !== '' ? (
                      <Typography.Text style={{ fontSize: 12 }}>四至：{record.boundaries}</Typography.Text>
                    ) : null}
                    {record.source === 'upgrade-backfill' ? (
                      <Tag color="default">升级时按原地块编号回填的历史宗地</Tag>
                    ) : null}
                    {record.status === '挂起复核' && record.holdReason !== '' ? (
                      <Alert type="error" showIcon message="挂起原因" description={record.holdReason} />
                    ) : null}
                    {issueList.length > 0 ? (
                      <Alert
                        type="warning"
                        showIcon
                        message={`自动核对发现 ${issueList.length} 项对不上`}
                        description={
                          <ul style={{ margin: 0, paddingLeft: 18 }}>
                            {issueList.map((item) => (
                              <li key={item}>{item}</li>
                            ))}
                          </ul>
                        }
                      />
                    ) : null}
                    {view.shape === 'merge' ? renderMergeRounds(record, view) : null}
                    {view.shape === 'split' ? renderSplitDetail(record, view) : null}
                  </Space>
                );
              },
            }}
          />
        )}
      </Card>

      {/* 新建 / 编辑宗地 */}
      <Drawer
        title={editing === null ? '登记权属宗地' : `编辑宗地 · ${editing.parcelCode}`}
          open={open}
          width={520}
          onClose={() => setOpen(false)}
          extra={
            <Space>
              <Button onClick={() => setOpen(false)}>取消</Button>
              <Button type="primary" loading={submitting} onClick={() => void handleSubmit()}>
                保存
              </Button>
            </Space>
          }
        >
          <Form form={form} layout="vertical">
            <Form.Item name="parcelCode" label="宗地编号" rules={[{ required: true, message: '请填写宗地编号' }]}>
              <Input placeholder="如：LD-DG-2025-017" />
            </Form.Item>
            <Space size={12} style={{ display: 'flex' }}>
              <Form.Item name="ownerName" label="权属人 / 单位" style={{ flex: 1 }} rules={[{ required: true }]}>
                <Input placeholder="如：东港镇红树林管护站" />
              </Form.Item>
              <Form.Item name="areaMu" label="权属面积（亩）" style={{ flex: 1 }} rules={[{ required: true }]}>
                <InputNumber min={0.1} max={5000} step={0.1} style={{ width: '100%' }} />
              </Form.Item>
            </Space>
            <Form.Item name="effectiveDate" label="重划生效日期" rules={[{ required: true }]}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="boundaries" label="四至">
              <Input.TextArea rows={3} placeholder="东：…；南：…；西：…；北：…" />
            </Form.Item>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              状态字段仅在台账列表中切换；状态候选：{PARCEL_STATUS_OPTIONS.join(' / ')}。
            </Typography.Text>
          </Form>
        </Drawer>

      {/* 挂接管理抽屉 */}
      <Drawer
        title={linkParcel === null ? '挂接修复地块' : `挂接与口径 · ${linkParcel.parcelCode}`}
        open={linkParcel !== null}
        width={640}
        onClose={() => setLinkParcel(null)}
      >
        {linkParcel !== null && drawerView !== null ? (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Alert
              type={linkParcel.status === '挂起复核' ? 'error' : drawerIssues.length > 0 ? 'warning' : 'success'}
              showIcon
              message={
                linkParcel.status === '挂起复核'
                  ? '该宗地正挂起复核，关联地块不出补植计划'
                  : drawerIssues.length > 0
                    ? `自动核对发现 ${drawerIssues.length} 项对不上`
                    : '两边数据对得上'
              }
              description={
                linkParcel.status === '挂起复核' && linkParcel.holdReason !== ''
                  ? linkParcel.holdReason
                  : drawerIssues.length > 0
                    ? drawerIssues.join('；')
                    : `权属面积 ${linkParcel.areaMu} 亩，挂接地块面积合计 ${drawerView.linkedAreaSum} 亩，在 2% 容差内。`
              }
            />

            <Card size="small" title="新增挂接关系">
              <Form form={linkForm} layout="vertical" initialValues={{ linkType: 'direct', team: '', splitAreaMu: 0 }}>
                <Space size={10} style={{ display: 'flex' }} align="end">
                  <Form.Item name="plotId" label="修复地块" style={{ flex: 2 }} rules={[{ required: true, message: '请选择地块' }]}>
                    <Select
                      showSearch
                      optionFilterProp="label"
                      options={plots.map((plot) => ({ value: plot.id, label: `${plot.name}（${plot.areaMu} 亩）` }))}
                    />
                  </Form.Item>
                  <Form.Item name="linkType" label="关系" style={{ flex: 1 }} rules={[{ required: true }]}>
                    <Select
                      options={PARCEL_LINK_TYPE_OPTIONS.map((value) => ({ value, label: PARCEL_LINK_TYPE_LABEL[value] }))}
                      onChange={(value: ParcelLinkType) => {
                        if (value !== 'split-child') linkForm.setFieldValue('splitAreaMu', 0);
                      }}
                    />
                  </Form.Item>
                </Space>
                <Space size={10} style={{ display: 'flex' }} align="end">
                  <Form.Item name="team" label="承接班组（分宗子块）" style={{ flex: 1 }}>
                    <Input placeholder="如：北屿一班" />
                  </Form.Item>
                  <Form.Item
                    noStyle
                    shouldUpdate={(prev, next) => prev.linkType !== next.linkType}
                  >
                    {({ getFieldValue }) =>
                      getFieldValue('linkType') === 'split-child' ? (
                        <Form.Item name="splitAreaMu" label="分宗面积（亩）" style={{ flex: 1 }} rules={[{ required: true }]}>
                          <InputNumber min={0.1} step={0.1} style={{ width: '100%' }} />
                        </Form.Item>
                      ) : null
                    }
                  </Form.Item>
                  <Button type="primary" icon={<PlusOutlined />} onClick={() => void handleCreateLink()}>
                    挂接
                  </Button>
                </Space>
              </Form>
            </Card>

            <Card size="small" title={`已挂接 ${drawerLinks.length} 条`}>
              {drawerLinks.length === 0 ? (
                <Typography.Text type="secondary">还没有挂接关系，新增后才会对接项目部数据。</Typography.Text>
              ) : (
                <Table<ParcelLink>
                  rowKey="id"
                  size="small"
                  pagination={false}
                  dataSource={drawerLinks}
                  columns={[
                    {
                      title: '地块',
                      dataIndex: 'plotId',
                      render: (value: string) => plotName(value),
                    },
                    {
                      title: '关系',
                      dataIndex: 'linkType',
                      width: 110,
                      render: (value: ParcelLinkType) => <Tag>{PARCEL_LINK_TYPE_LABEL[value]}</Tag>,
                    },
                    {
                      title: '班组 / 分宗面积',
                      key: 'team',
                      width: 150,
                      render: (_value, record) =>
                        record.linkType === 'split-child'
                          ? `${record.team || '—'} · ${record.splitAreaMu} 亩`
                          : record.team || '—',
                    },
                    {
                      title: '',
                      key: 'op',
                      width: 64,
                      render: (_value, record) => (
                        <Button
                          size="small"
                          type="link"
                          danger
                          icon={<DeleteOutlined />}
                          onClick={async () => {
                            await deleteLink(record.id);
                            message.success('挂接关系已删除');
                          }}
                        />
                      ),
                    },
                  ]}
                />
              )}
            </Card>

            {drawerView.shape === 'merge' ? (
              <Card size="small" title="并宗成活率口径">{renderMergeRounds(linkParcel, drawerView)}</Card>
            ) : null}
            {drawerView.shape === 'split' ? (
              <Card size="small" title="分宗历史测次归属">{renderSplitDetail(linkParcel, drawerView)}</Card>
            ) : null}

            <Timeline
              items={[
                { color: 'gray', children: '并宗：老地块编号与栽植 / 验收记录原样保留，不按权属面积加权。' },
                { color: 'gray', children: '分宗：历史测次归母块留档，两侧子块只读继承；分宗后新测次记到具体班组子块。' },
                { color: 'red', children: '对不上的先挂起复核，挂起期间不出补植计划。' },
              ]}
            />
          </Space>
        ) : null}
      </Drawer>

      {/* 挂起原因 */}
      <Modal
        title={holdTarget === null ? '挂起复核' : `挂起复核 · ${holdTarget.parcelCode}`}
        open={holdTarget !== null}
        onCancel={() => setHoldTarget(null)}
        onOk={() => void handleHold()}
        okText="确认挂起"
        okButtonProps={{ danger: true }}
        cancelText="取消"
      >
        <Form form={holdForm} layout="vertical">
          <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
            挂起后该宗地关联的修复地块在复核通过前不能生成或推进补植计划；已有栽植与验收数据保留可见。
          </Typography.Paragraph>
          <Form.Item name="holdReason" label="挂起原因" rules={[{ required: true, message: '请填写对不上的具体情况' }]}>
            <Input.TextArea rows={3} placeholder="如：权属面积与项目部面积差 6.4 亩，四至北界与现场界桩不符" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
