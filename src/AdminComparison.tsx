import { adminFetch } from './adminFetch'
import { accountWrite } from './adminAccountApi'
import { Alert, Button, Card, Descriptions, Form, Grid, Input, Modal, Select, Space, Table } from 'antd'
import { useEffect, useRef, useState } from 'react'

type Snapshot = {
  id: string; type: string; from: string; to: string; formulaVersion: string
  datasetVersion: number; sampleSize: number; excludedSize: number; status: string; version: number
  builtAt?: string; failureReason?: string; retryCount?: number; nextRunAt?: string
  metrics: Record<string, Cell | Record<string, Cell>>
}
type Cell = { n: number; mean: number }
type MinimumChange = { type: string; minimum: number | null; reason: string; expectedVersion: number }
type Settings = { type: string; minimum: number | null; version: number }
type Publication = { id: string; snapshotId: string; type: string; status: string; startsAt: string; endsAt: string }
const metricLabels: Record<string, string> = {
  YFSI_MEAN: 'YFSI 평균', EXTERNAL_AREA_MEAN: '외부 압박 영역 평균',
  RESOURCE_DOMAIN_MEAN: '대응자원 영역 평균', PERCEIVED_STRESS_MEAN: '체감 스트레스 평균',
}
const publicationActions = { PUBLISH: '즉시 게시', SCHEDULE: '예약', UNPUBLISH: '비공개' }
type PublicationChange = { action: keyof typeof publicationActions; replacePublicationId?: string; reason?: string }
type PendingPublication = { change: PublicationChange; snapshotId: string; version: number }
type Preview = { version: number; metrics: Record<string, number | Record<string, number>>; startsAt: string | null; endsAt: string | null }

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

function PublicMetrics({ preview, keys }: { preview: Preview; keys?: string[] }) {
  const entries = Object.entries(preview.metrics).filter(([key]) => !keys || keys.includes(key))
  return <section aria-label="앱 공개 지표 미리보기">
    <h3>앱 공개 지표 미리보기</h3>
    {entries.length === 0 ? <p>공개 가능한 지표가 없어요.</p> : <ul>{entries.map(([key, value]) => (
      <li key={key}>{metricLabels[key] ?? key}
        {typeof value === 'number' ? ' · ' + value + '점' : <ul>{Object.entries(value).map(([area, mean]) => (
          <li key={area}>{types[area as keyof typeof types] ?? area} · {mean}점</li>
        ))}</ul>}
      </li>
    ))}</ul>}
    {preview.startsAt && preview.endsAt && <p>승인된 공개 기간 {retryTime.format(new Date(preview.startsAt))} ~ {retryTime.format(new Date(preview.endsAt))} (KST)</p>}
  </section>
}

class ComparisonError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function decode<T>(response: Response): Promise<T> {
  if (response.ok) return response.json() as Promise<T>
  const messages: Record<number, string> = {
    401: '다시 로그인해주세요.', 403: '집계를 처리할 권한이 없습니다.',
    409: '집계 상태가 바뀌었습니다. 새로고침해주세요.', 422: '집계 유형과 기간을 확인해주세요.',
  }
  throw new ComparisonError(messages[response.status] ?? '집계 요청을 완료하지 못했습니다.', response.status)
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
  const [pendingMinimum, setPendingMinimum] = useState<MinimumChange>()
  const [code, setCode] = useState('')
  const [minimumError, setMinimumError] = useState<string>()
  const [pendingPublication, setPendingPublication] = useState<PendingPublication>()
  const [previewState, setPreviewState] = useState<{ id: string; data?: Preview }>()
  const lastTransition = useRef<{ fingerprint: string; key: string } | undefined>(undefined)
  const current = items.find((item) => item.id === selected)
  const live = publications.find((item) => item.type === current?.type && item.status === 'ACTIVE')
  const liveSnapshot = items.find((item) => item.id === live?.snapshotId)
  const minimum = settings.find((item) => item.type === current?.type)?.minimum
  const preview = previewState?.id === current?.id && previewState?.data?.version === current?.version
    ? previewState?.data : undefined

  useEffect(() => {
    const id = current?.id
    const version = current?.version
    if (!id) return
    const controller = new AbortController()
    void adminFetch(path + '/' + id + '/preview', { signal: controller.signal }).then(decode<Preview>).then((data) => {
      if (!controller.signal.aborted) setPreviewState({ id, data: data.version === version ? data : undefined })
    }).catch(() => {
      if (!controller.signal.aborted) setPreviewState({ id })
    })
    return () => controller.abort()
  }, [current?.id, current?.version, settings])

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

  async function run(operation: () => Promise<Snapshot>, onSaved?: () => void) {
    setBusy(true)
    setError(undefined)
    try {
      const snapshot = await operation()
      onSaved?.()
      setItems((previous) => [snapshot, ...previous.filter((item) => item.id !== snapshot.id)])
      setSelected(snapshot.id)
      await refresh()
    } catch (error) {
      setError(error instanceof Error ? error.message : '요청을 완료하지 못했습니다.')
    } finally {
      setBusy(false)
    }
  }

  async function saveMinimum(change: MinimumChange, otp?: string) {
    setBusy(true)
    setError(undefined)
    setMinimumError(undefined)
    const { type, ...body } = change
    try {
      if (otp) await accountWrite('/auth/reauth', 'POST', { code: otp })
      await write<Settings>(path + '/settings/' + type, body, 'PATCH')
      setPendingMinimum(undefined)
      await refresh()
    } catch (failure) {
      if (failure instanceof ComparisonError && failure.status === 428) {
        setPendingMinimum(change)
      } else if (failure instanceof ComparisonError && failure.status === 409) {
        setPendingMinimum(undefined)
        report(failure)
      } else if (otp) {
        setMinimumError(failure instanceof Error ? failure.message : '표본 기준을 저장하지 못했습니다.')
      } else {
        report(failure)
      }
    } finally {
      setBusy(false)
      setCode('')
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
          <Form layout="vertical" onFinish={(values: { type: string; minimum?: string; reason: string }) => {
            const config = settings.find((item) => item.type === values.type)
            if (!config) return
            void saveMinimum({
              type: config.type,
              minimum: values.minimum ? Number(values.minimum) : null,
              reason: values.reason,
              expectedVersion: config.version,
            })
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
        {pendingMinimum && <Modal open title="표본 기준 변경 재인증"
          okText="재인증 후 저장" cancelText="취소" confirmLoading={busy}
          okButtonProps={{ disabled: !/^\d{6}$/.test(code) }}
          onCancel={() => {
            if (busy) return
            setPendingMinimum(undefined)
            setMinimumError(undefined)
            setCode('')
          }}
          onOk={() => void saveMinimum(pendingMinimum, code)}>
          <Space orientation="vertical" style={{ display: 'flex' }}>
            {minimumError && <Alert type="error" title={minimumError} />}
            <Input aria-label="인증 앱의 6자리 코드" autoComplete="one-time-code" inputMode="numeric"
              maxLength={6} value={code} onChange={(event) => setCode(event.target.value)} />
          </Space>
        </Modal>}
        <p>현재 공개·예약 {publications.length}건</p>
        {publications.map((item) => (
          <div key={item.id}>
            {types[item.type as keyof typeof types]} · {item.status === 'ACTIVE' ? '공개 중' : '예약'} · {retryTime.format(new Date(item.startsAt))} ~ {retryTime.format(new Date(item.endsAt))} (KST)
            {items.some((snapshot) => snapshot.id === item.snapshotId) &&
              <Button type="link" onClick={() => setSelected(item.snapshotId)}>집계 보기</Button>}
          </div>
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
          <Descriptions size="small" column={1} items={[
            { key: 'builtAt', label: '집계 완료 (KST)', children: current.builtAt ? retryTime.format(new Date(current.builtAt)) : '—' },
            { key: 'minimum', label: '공개 최소 표본', children: minimum == null ? '미설정' : minimum + '명' },
            { key: 'live', label: '같은 유형의 현재 공개본', children: liveSnapshot
              ? liveSnapshot.from + ' ~ ' + liveSnapshot.to + ' · ' + liveSnapshot.sampleSize + '명 · ' + liveSnapshot.formulaVersion
              : live ? '공개 중 · 집계 목록에서 확인할 수 없습니다.' : '공개본 없음' },
          ]} />
          {current.status === 'IN_REVIEW' && (minimum == null || current.sampleSize < minimum) &&
            <Alert type="warning" title={minimum == null ? '최소 표본 기준을 설정해야 승인할 수 있어요.' : '표본이 공개 최소 기준에 미달해요.'} />}
          {current.failureReason === 'SOURCE_CHANGED' && <Alert type="warning" title="원천 데이터가 바뀌었습니다. 집계를 다시 요청해주세요." />}
          {current.failureReason === 'BUILD_FAILED' && <Alert type="error" title="집계에 실패했습니다. 원인을 확인한 뒤 집계를 다시 요청해주세요." />}
          {current.nextRunAt && <Alert type="info" title={'다음 집계 시도 ' + retryTime.format(new Date(current.nextRunAt)) + ' (KST)'} />}
          {previewState?.id === current.id && !preview && <Alert type="warning" title="앱 공개 지표를 확인할 수 없어요. 목록을 새로고침해 주세요." />}
          {preview && !(supervisor && current.status === 'IN_REVIEW') && <PublicMetrics preview={preview} />}
          {Object.entries(current.metrics).map(([key, value]) => (
            <div key={key}>
              <strong>{metricLabels[key] ?? key}</strong>
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
                <Select mode="multiple" options={Object.entries(metricLabels).map(([value, label]) => ({
                  value, label, disabled: preview ? !Object.hasOwn(preview.metrics, value) : false,
                }))} />
              </Form.Item>
              {preview && <Form.Item noStyle shouldUpdate={(before, after) => before.allowedMetrics !== after.allowedMetrics}>
                {({ getFieldValue }) => <PublicMetrics preview={preview} keys={getFieldValue('allowedMetrics') ?? []} />}
              </Form.Item>}
              <div className="admin-user-filters">
                <Form.Item name="startsAt" label="공개 시작 (KST)" rules={[{ required: true }]}><Input type="datetime-local" /></Form.Item>
                <Form.Item name="endsAt" label="공개 종료 (KST)" rules={[{ required: true }]}><Input type="datetime-local" /></Form.Item>
                <Form.Item name="reason" label="승인 사유 (자기승인 필수)" rules={[{ max: 500 }]}><Input /></Form.Item>
              </div>
              <Button htmlType="submit" loading={busy} disabled={minimum == null || current.sampleSize < minimum}>승인</Button>
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
            <Form<PublicationChange> key={current.id + '-publication'} layout="vertical" onFinish={(change) => {
              setError(undefined)
              setPendingPublication({ change, snapshotId: current.id, version: current.version })
            }}>
              <div className="admin-user-filters">
                <Form.Item name="action" label="공개 작업" rules={[{ required: true }]}>
                  <Select options={Object.entries(publicationActions).map(([value, label]) => ({ value, label }))} />
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
          {pendingPublication && <Modal open title={publicationActions[pendingPublication.change.action] + ' 확인'}
            okText={publicationActions[pendingPublication.change.action]} cancelText="취소" confirmLoading={busy}
            onCancel={() => { if (!busy) setPendingPublication(undefined) }}
            onOk={() => void run(() => transition(pendingPublication.snapshotId, {
              ...pendingPublication.change, expectedVersion: pendingPublication.version,
            }), () => setPendingPublication(undefined))}>
            <p>{types[current.type as keyof typeof types]} · {current.from} ~ {current.to} · 표본 {current.sampleSize}명</p>
            {pendingPublication.change.replacePublicationId && <p>교체할 공개본 ID {pendingPublication.change.replacePublicationId}</p>}
            {error && <Alert type="error" title={error} />}
          </Modal>}
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
