import { useAdminUnsaved } from './adminNavigation'
import { Alert, Button, Card, Form, Input, Modal, Select, Space, Table, Tag, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { accountRead, accountWrite, AdminAccountError } from './adminAccountApi'

type Fields = { name: string; screenId: string; variants: string[]; startsAt: string; endsAt: string }
type Status = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'ENDED'
type Action = 'ACTIVATE' | 'PAUSE' | 'END'
type Experiment = Fields & { id: string; status: Status; version: number; endedAt: string | null }
type Listing = { items: Experiment[]; capability: { screenId: string; variants: string[]; enabled: boolean } }
type VariantStats = { variantId: string; exposed: number; completed: number }
type Report = { experiment: Experiment; variants: VariantStats[] }
type Dialog =
  | { mode: 'edit'; item?: Experiment }
  | { mode: 'transition'; item: Experiment; action: Action }
  | { mode: 'results'; item: Experiment }

const root = '/experiments'
const statuses: Record<Status, string> = { DRAFT: '초안', ACTIVE: '활성', PAUSED: '일시정지', ENDED: '종료' }
const actions: Record<Action, string> = { ACTIVATE: '활성화', PAUSE: '일시정지', END: '종료' }
const screens: Record<string, string> = { B_006: '자가진단 안내 (B_006)' }
const variants: Record<string, string> = { SUMMARY_FIRST: '문항·소요 시간 먼저', RESTART_FIRST: '재시작 안내 먼저' }
const seoulTime = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Seoul' })
const percent = new Intl.NumberFormat('ko-KR', { style: 'percent', maximumFractionDigits: 1 })
const time = (value: string) => seoulTime.format(new Date(value))
const inputTime = (value: string) => new Date(Date.parse(value) + 9 * 3_600_000).toISOString().slice(0, 16)
const fromInputTime = (value: string) => value + ':00+09:00'

export default function AdminExperiments({ operator, supervisor }: { operator: boolean; supervisor: boolean }) {
  const [form] = Form.useForm<Fields>()
  const [transitionForm] = Form.useForm<{ reason: string }>()
  const [data, setData] = useState<Listing>()
  const [report, setReport] = useState<Report>()
  const [dialog, setDialog] = useState<Dialog>()
  const { mark: markUnsaved } = useAdminUnsaved(dialog?.mode === 'edit' || dialog?.mode === 'transition')
  const [revision, refresh] = useState(0)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const [dialogError, setDialogError] = useState<string>()

  useEffect(() => {
    const request = new AbortController()
    void accountRead<Listing>(root, request.signal).then((result) => {
      if (!request.signal.aborted) setData(result)
    }).catch(() => {
      if (!request.signal.aborted) setError('실험 목록을 불러오지 못했습니다.')
    }).finally(() => {
      if (!request.signal.aborted) setLoading(false)
    })
    return () => request.abort()
  }, [revision])

  useEffect(() => {
    if (dialog?.mode !== 'results') return
    const request = new AbortController()
    void accountRead<Report>(root + '/' + dialog.item.id + '/results', request.signal).then((result) => {
      if (!request.signal.aborted) setReport(result)
    }).catch(() => {
      if (!request.signal.aborted) setDialogError('실험 결과를 불러오지 못했습니다.')
    })
    return () => request.abort()
  }, [dialog])

  function reload() {
    setLoading(true)
    setError(undefined)
    refresh((current) => current + 1)
  }

  function open(next: Dialog) {
    setDialogError(undefined)
    setReport(undefined)
    if (next.mode === 'edit') {
      const item = next.item
      form.resetFields()
      form.setFieldsValue(item ? { ...item, startsAt: inputTime(item.startsAt), endsAt: inputTime(item.endsAt) }
        : { screenId: data?.capability.screenId, variants: data?.capability.variants })
    }
    if (next.mode === 'transition') transitionForm.resetFields()
    setDialog(next)
  }

  async function save(operation: () => Promise<Experiment>) {
    setDialogError(undefined)
    setSaving(true)
    try {
      await operation()
      setDialog(undefined)
      reload()
    } catch (failure) {
      setDialogError(failure instanceof AdminAccountError && failure.status === 409
        ? '상태가 바뀌었거나 같은 화면에 활성 실험이 있습니다. 목록을 새로고침해주세요.'
        : failure instanceof Error ? failure.message : '실험을 저장하지 못했습니다.')
    } finally {
      setSaving(false)
    }
  }

  function saveFields(values: Fields) {
    if (dialog?.mode !== 'edit') return
    const fields = { ...values, name: values.name.trim(), startsAt: fromInputTime(values.startsAt),
      endsAt: fromInputTime(values.endsAt) }
    const item = dialog.item
    void save(() => item ? accountWrite<Experiment>(root + '/' + item.id, 'PATCH', { fields, expectedVersion: item.version })
      : accountWrite<Experiment>(root, 'POST', fields))
  }

  function changeStatus({ reason }: { reason: string }) {
    if (dialog?.mode !== 'transition') return
    const { item, action } = dialog
    void save(() => accountWrite<Experiment>(root + '/' + item.id + '/transitions', 'POST',
      { action, expectedVersion: item.version, reason: reason.trim() }))
  }

  return <Card title="실험 관리">
    <Space orientation="vertical" style={{ display: 'flex' }}>
      {error && <Alert type="error" title={error} />}
      {data?.capability.enabled === false && <Alert type="warning" title="자가진단 안내 실험 기능이 꺼져 있습니다." />}
      <Space wrap>
        {operator && <Button type="primary" disabled={!data} onClick={() => open({ mode: 'edit' })}>실험 초안 만들기</Button>}
        <Button loading={loading} onClick={reload}>새로고침</Button>
      </Space>
      <Table<Experiment> rowKey="id" loading={loading} dataSource={data?.items ?? []} scroll={{ x: 900 }}
        pagination={{ pageSize: 20, showSizeChanger: false }} columns={[
          { title: '실험명', render: (_, item) => <Button type="link" onClick={() => open({ mode: 'results', item })}>{item.name}</Button> },
          { title: '화면', render: (_, item) => screens[item.screenId] ?? item.screenId },
          { title: '기간 (KST)', render: (_, item) => time(item.startsAt) + ' ~ ' + time(item.endsAt) },
          { title: '상태', render: (_, item) => <Tag color={item.status === 'ACTIVE' ? 'green' : undefined}>{statuses[item.status]}</Tag> },
          { title: '작업', render: (_, item) => <Space wrap>
            {operator && item.status === 'DRAFT' && <Button onClick={() => open({ mode: 'edit', item })}>초안 수정</Button>}
            {supervisor && data?.capability.enabled && ['DRAFT', 'PAUSED'].includes(item.status) &&
              <Button onClick={() => open({ mode: 'transition', item, action: 'ACTIVATE' })}>
                {item.status === 'PAUSED' ? '다시 활성화' : actions.ACTIVATE}
              </Button>}
            {supervisor && item.status === 'ACTIVE' && <Button onClick={() => open({ mode: 'transition', item, action: 'PAUSE' })}>{actions.PAUSE}</Button>}
            {supervisor && ['ACTIVE', 'PAUSED'].includes(item.status) && <Button danger onClick={() => open({ mode: 'transition', item, action: 'END' })}>{actions.END}</Button>}
          </Space> },
        ]} />
    </Space>
    <Modal forceRender open={dialog?.mode === 'edit'} title={dialog?.mode === 'edit' && dialog.item ? '실험 초안 수정' : '실험 초안 만들기'}
      okText="저장" confirmLoading={saving} onOk={() => form.submit()} onCancel={() => { if (!saving) setDialog(undefined) }}>
      {dialog?.mode === 'edit' && dialogError && <Alert type="error" title={dialogError} />}
      <Form<Fields> form={form} onValuesChange={markUnsaved} layout="vertical" onFinish={saveFields} disabled={saving}>
        <Form.Item name="name" label="실험명" rules={[{ required: true, whitespace: true, max: 80 }]}><Input maxLength={80} /></Form.Item>
        <Form.Item name="screenId" label="화면" rules={[{ required: true }]}>
          <Select options={data ? [{ value: data.capability.screenId, label: screens[data.capability.screenId] }] : []} />
        </Form.Item>
        <Form.Item name="variants" label="표시안" rules={[{ required: true, type: 'array', min: 2, max: 4 }]}>
          <Select mode="multiple" options={data?.capability.variants.map((value) => ({ value, label: variants[value] ?? value }))} />
        </Form.Item>
        <Form.Item name="startsAt" label="시작 (KST)" rules={[{ required: true }]}><Input type="datetime-local" /></Form.Item>
        <Form.Item name="endsAt" label="종료 (KST)" dependencies={['startsAt']} rules={[{ required: true }, ({ getFieldValue }) => ({
          validator: (_, value: string) => !value || value > getFieldValue('startsAt') ? Promise.resolve()
            : Promise.reject(new Error('종료는 시작보다 늦어야 합니다.')),
        })]}><Input type="datetime-local" /></Form.Item>
      </Form>
    </Modal>
    <Modal forceRender open={dialog?.mode === 'transition'} title={dialog?.mode === 'transition' ? actions[dialog.action] : '실험 상태 변경'}
      okText="확인" confirmLoading={saving} onOk={() => transitionForm.submit()} onCancel={() => { if (!saving) setDialog(undefined) }}>
      {dialog?.mode === 'transition' && dialogError && <Alert type="error" title={dialogError} />}
      {dialog?.mode === 'transition' && <Typography.Paragraph>{dialog.item.name}</Typography.Paragraph>}
      <Form form={transitionForm} onValuesChange={markUnsaved} layout="vertical" onFinish={changeStatus} disabled={saving}>
        <Form.Item name="reason" label="변경 사유" rules={[{ required: true, whitespace: true, max: 300 }]}>
          <Input.TextArea maxLength={300} />
        </Form.Item>
      </Form>
    </Modal>
    <Modal open={dialog?.mode === 'results'} title={dialog?.mode === 'results' ? dialog.item.name : '실험 결과'}
      footer={null} onCancel={() => setDialog(undefined)}>
      {dialog?.mode === 'results' && dialogError && <Alert type="error" title={dialogError} />}
      {report && <Space orientation="vertical" style={{ display: 'flex' }}>
        <Typography.Text>{time(report.experiment.startsAt)} ~ {time(report.experiment.endsAt)} (KST)</Typography.Text>
        {report.experiment.endedAt && report.experiment.endedAt !== report.experiment.endsAt &&
          <Typography.Text>조기 종료 {time(report.experiment.endedAt)} (KST)</Typography.Text>}
        <Typography.Text type="secondary">최초 노출 후 같은 진단에서 24시간 이내이면서 실험 종료 전에 제출한 사용자를 집계합니다.</Typography.Text>
      </Space>}
      <Table<VariantStats> rowKey="variantId" loading={!report && !dialogError} dataSource={report?.variants ?? []} pagination={false}
        columns={[
          { title: '표시안', render: (_, row) => variants[row.variantId] ?? row.variantId },
          { title: '노출 표본', dataIndex: 'exposed', align: 'right' },
          { title: '완료율', render: (_, row) => row.exposed ? percent.format(row.completed / row.exposed) : '—', align: 'right' },
        ]} />
    </Modal>
  </Card>
}
