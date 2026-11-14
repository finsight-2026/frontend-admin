import { adminFetch } from './adminFetch'
import { Alert, Button, Card, Form, Grid, Input, Select, Space, Table } from 'antd'
import { useEffect, useRef, useState } from 'react'

type Snapshot = {
  id: string; type: string; from: string; to: string; formulaVersion: string
  datasetVersion: number; sampleSize: number; excludedSize: number; status: string; version: number
  failureReason?: string; retryCount?: number; nextRunAt?: string
  metrics: Record<string, Cell | Record<string, Cell>>
}
type Cell = { n: number; mean: number }
type Settings = { type: string; minimum: number | null; version: number }
type Publication = { id: string; snapshotId: string; type: string; status: string; startsAt: string; endsAt: string }
const metricKeys = ['YFSI_MEAN', 'EXTERNAL_AREA_MEAN', 'RESOURCE_DOMAIN_MEAN', 'PERCEIVED_STRESS_MEAN']

const path = '/api/v1/admin/comparison-snapshots'
const types = {
  DEBT: '부채부담형', INCOME: '소득불안형', EMERGENCY_FUND: '비상자금취약형',
  FIXED_COST: '고정비압박형', FUTURE: '미래불안형', FAMILY: '부양부담형',
}
const statuses: Record<string, string> = {
  BUILDING: '집계 중', READY: '집계 완료', FAILED: '집계 실패',
  IN_REVIEW: '검토 중', APPROVED: '승인', INVALIDATED: '무효',
}
const retryTime = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Seoul' })

async function decode<T>(response: Response): Promise<T> {
  if (response.ok) return response.json() as Promise<T>
  const messages: Record<number, string> = {
    401: '다시 로그인해주세요.', 403: '집계를 처리할 권한이 없습니다.',
    409: '집계 상태가 바뀌었습니다. 새로고침해주세요.', 422: '집계 유형과 기간을 확인해주세요.',
  }
  throw new Error(messages[response.status] ?? '집계 요청을 완료하지 못했습니다.')
}

async function write<T>(url: string, body: object, method = "POST", key?: string) {
  const csrf = await decode<{ token: string; headerName: string }>(await adminFetch('/api/v1/admin/auth/csrf'))
  return decode<T>(await adminFetch(url, {
    method,
    headers: { [csrf.headerName]: csrf.token, 'Content-Type': 'application/json',
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    body: JSON.stringify(body),
  }))
}

export default function AdminComparison({ operator, supervisor }: { operator: boolean; supervisor: boolean }) {
  const { md } = Grid.useBreakpoint()
  const [settings, setSettings] = useState<Settings[]>([])
  const [publications, setPublications] = useState<Publication[]>([])
  const [items, setItems] = useState<Snapshot[]>([])
  const [selected, setSelected] = useState<string>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const lastTransition = useRef<{ fingerprint: string; key: string } | undefined>(undefined)
  const current = items.find((item) => item.id === selected)

  async function refresh(signal?: AbortSignal) {
    const [snapshots, config, active] = await Promise.all([
      adminFetch(path, { signal }).then(decode<Snapshot[]>),
      adminFetch(path + '/settings', { signal }).then(decode<Settings[]>),
      adminFetch(path + '/publications', { signal }).then(decode<Publication[]>),
    ])
    if (signal?.aborted) return
    setItems(snapshots)
    setSettings(config)
    setPublications(active)
  }

  function report(error: unknown) {
    setError(error instanceof Error ? error.message : '요청을 완료하지 못했습니다.')
  }

  useEffect(() => {
    const controller = new AbortController()
    void Promise.resolve().then(() => refresh(controller.signal)).catch((error: unknown) => {
      if (!controller.signal.aborted) report(error)
    })
    return () => controller.abort()
  }, [])

  async function run(operation: () => Promise<Snapshot>) {
    setBusy(true)
    setError(undefined)
    try {
      const snapshot = await operation()
      setItems((previous) => [snapshot, ...previous.filter((item) => item.id !== snapshot.id)])
      setSelected(snapshot.id)
      await refresh()
    } catch (error) {
      setError(error instanceof Error ? error.message : '요청을 완료하지 못했습니다.')
    } finally {
      setBusy(false)
    }
  }

  function transition(id: string, body: object) {
    const fingerprint = JSON.stringify([id, body])
    if (lastTransition.current?.fingerprint !== fingerprint) {
      lastTransition.current = { fingerprint, key: crypto.randomUUID() }
    }
    return write<Snapshot>(path + '/' + id + '/transitions', body, 'POST', lastTransition.current.key)
  }

  return (
    <Card title="익명 비교 집계">
      <Space orientation="vertical" style={{ display: 'flex' }}>
        {error && <Alert type="error" title={error} />}
        {operator && (
          <Form layout="vertical" onFinish={(values: { type: string; from?: string; to?: string }) =>
            run(() => write<Snapshot>(path, { type: values.type, from: values.from || null, to: values.to || null, formulaVersion: 'yfsi-v1' }))}>
            <div className="admin-user-filters">
              <Form.Item name="type" label="유형" rules={[{ required: true }]}><Select options={Object.entries(types).map(([value, label]) => ({ value, label }))} /></Form.Item>
              <Form.Item name="from" label="집계 시작일 (KST)"><Input type="date" /></Form.Item>
              <Form.Item name="to" label="집계 종료일 (KST)"><Input type="date" /></Form.Item>
            </div>
            <Button type="primary" htmlType="submit" loading={busy}>집계 요청</Button>
          </Form>
        )}
        <Button disabled={busy} onClick={() => { setError(undefined); void refresh().catch(report) }}>목록 새로고침</Button>
        {supervisor && (
          <Form layout="vertical" onFinish={async (values: { type: string; minimum?: string; reason: string }) => {
            const config = settings.find((item) => item.type === values.type)
            if (!config) return
            setBusy(true)
            setError(undefined)
            try {
              await write<Settings>(path + '/settings/' + config.type, {
                minimum: values.minimum ? Number(values.minimum) : null,
                reason: values.reason,
                expectedVersion: config.version,
              }, 'PATCH')
              await refresh()
            } catch (error) {
              report(error)
            } finally {
              setBusy(false)
            }
          }}>
            <div className="admin-user-filters">
              <Form.Item name="type" label="표본 기준 유형" rules={[{ required: true }]}>
                <Select options={settings.map((item) => ({
                  value: item.type,
                  label: (types[item.type as keyof typeof types] ?? item.type) + ' · ' + (item.minimum ?? '미설정'),
                }))} />
              </Form.Item>
              <Form.Item name="minimum" label="최소 표본 (빈칸은 미설정)"><Input type="number" min={30} /></Form.Item>
              <Form.Item name="reason" label="변경 사유" rules={[{ required: true, min: 10, max: 500 }]}><Input /></Form.Item>
            </div>
            <Button htmlType="submit" loading={busy}>표본 기준 저장</Button>
          </Form>
        )}
        <p>현재 공개·예약 {publications.length}건</p>
        {publications.map((item) => (
          <div key={item.id}>{types[item.type as keyof typeof types]} · {item.status === 'ACTIVE' ? '공개 중' : '예약'} · {item.id}</div>
        ))}
        <Table<Snapshot> rowKey="id" dataSource={items} scroll={md ? { x: 600 } : undefined} columns={[
          { title: '유형', dataIndex: 'type', render: (type: keyof typeof types, item) =>
            <Button type="link" onClick={() => setSelected(item.id)}>{types[type]}</Button> },
          { title: '집계 기간 (KST)', responsive: ['md'], render: (_, item) => item.from + ' ~ ' + item.to },
          { title: '표본', dataIndex: 'sampleSize', responsive: ['md'] },
          { title: '제외', dataIndex: 'excludedSize', responsive: ['md'] },
          { title: '상태', dataIndex: 'status', render: (status: string, item) => item.nextRunAt ? '재시도 대기' : statuses[status] },
        ]} />
        {current && <>
          {!md && <p>집계 기간 {current.from} ~ {current.to} · 표본 {current.sampleSize}명 · 제외 {current.excludedSize}명</p>}
          <p>산식 버전 {current.formulaVersion} · 원천 버전 {current.datasetVersion}</p>
          {current.failureReason === 'SOURCE_CHANGED' && <Alert type="warning" title="원천 데이터가 바뀌었습니다. 집계를 다시 요청해주세요." />}
          {current.failureReason === 'BUILD_FAILED' && <Alert type="error" title="집계에 실패했습니다. 원인을 확인한 뒤 집계를 다시 요청해주세요." />}
          {current.nextRunAt && <Alert type="info" title={'다음 집계 시도 ' + retryTime.format(new Date(current.nextRunAt)) + ' (KST)'} />}
          {Object.entries(current.metrics).map(([key, value]) => (
            <div key={key}>
              <strong>{key}</strong>
              {'mean' in value && typeof value.mean === 'number'
                ? <p>{value.mean}점 · {String(value.n)}명</p>
                : <ul>{Object.entries(value).map(([area, cell]) =>
                    <li key={area}>{area} · {cell.mean}점 · {cell.n}명</li>)}</ul>}
            </div>
          ))}
          {supervisor && current.status === 'IN_REVIEW' && (
            <Form key={current.id + '-approval'} layout="vertical" onFinish={(values: {
              allowedMetrics: string[]; startsAt: string; endsAt: string; reason?: string
            }) => run(() => transition(current.id, {
              action: 'APPROVE', expectedVersion: current.version, allowedMetrics: values.allowedMetrics,
              startsAt: values.startsAt + ':00+09:00', endsAt: values.endsAt + ':00+09:00', reason: values.reason,
            }))}>
              <Form.Item name="allowedMetrics" label="공개 허용 지표" rules={[{ required: true }]}>
                <Select mode="multiple" options={metricKeys.map((value) => ({ value, label: value }))} />
              </Form.Item>
              <div className="admin-user-filters">
                <Form.Item name="startsAt" label="공개 시작 (KST)" rules={[{ required: true }]}><Input type="datetime-local" /></Form.Item>
                <Form.Item name="endsAt" label="공개 종료 (KST)" rules={[{ required: true }]}><Input type="datetime-local" /></Form.Item>
                <Form.Item name="reason" label="승인 사유 (자기승인 필수)" rules={[{ max: 500 }]}><Input /></Form.Item>
              </div>
              <Button htmlType="submit" loading={busy}>승인</Button>
            </Form>
          )}
          {supervisor && current.status === 'IN_REVIEW' && (
            <Form key={current.id + '-rejection'} layout="vertical" onFinish={(values: { reason: string }) =>
              run(() => transition(current.id, {
                action: 'REJECT', expectedVersion: current.version, reason: values.reason,
              }))}>
              <Form.Item name="reason" label="반려 사유" rules={[{ required: true, min: 10, max: 500 }]}><Input /></Form.Item>
              <Button htmlType="submit" loading={busy}>반려</Button>
            </Form>
          )}
          {supervisor && current.status === 'APPROVED' && (
            <Form key={current.id + '-publication'} layout="vertical" onFinish={(values: {
              action: string; replacePublicationId?: string; reason?: string
            }) => run(() => transition(current.id, {
              ...values, expectedVersion: current.version,
            }))}>
              <div className="admin-user-filters">
                <Form.Item name="action" label="공개 작업" rules={[{ required: true }]}>
                  <Select options={[
                    { value: 'PUBLISH', label: '즉시 게시' }, { value: 'SCHEDULE', label: '예약' },
                    { value: 'UNPUBLISH', label: '비공개' },
                  ]} />
                </Form.Item>
                <Form.Item name="replacePublicationId" label="교체할 공개본 ID">
                  <Select allowClear options={publications.filter((item) => item.type === current.type)
                    .map((item) => ({ value: item.id, label: item.id }))} />
                </Form.Item>
                <Form.Item name="reason" label="비공개 사유" rules={[{ max: 500 }]}><Input /></Form.Item>
              </div>
              <Button htmlType="submit" loading={busy}>공개 작업 적용</Button>
            </Form>
          )}
          {operator && current.status === 'READY' && (
            <Button loading={busy} onClick={() => run(() =>
              transition(current.id, { action: 'SUBMIT', expectedVersion: current.version }))}>
              검토 요청
            </Button>
          )}
        </>}
      </Space>
    </Card>
  )
}
