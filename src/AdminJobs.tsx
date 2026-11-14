import { adminFetch } from './adminFetch'
import { Alert, Button, Card, Descriptions, Form, Input, Modal, Select, Space, Table, Tag, Typography } from 'antd'
import { useEffect, useRef, useState } from 'react'
import { exportWrite } from './adminExportApi'

type Filters = { kind?: string; status?: string; actorId?: string; from?: string; to?: string }
type Job = {
  id: string; kind: string; status: string; actorId?: string; scope: string
  requestedAt?: string; startedAt?: string; completedAt?: string; expiresAt?: string; dueAt?: string
  processed: number; total: number; retryCount: number; requeueCount?: number; retryable?: boolean; nextRunAt?: string; errorCode?: string
  overdue: boolean; deadlineWarning?: boolean; stage?: string
}
type Page = { items: Job[]; total: number }
const pageSize = 20

const kinds: Record<string, string> = {
  CAMPAIGN: '서비스 안내 캠페인', BULK_TAG: '일괄 태그', APP_EXPORT: '사용자 내보내기',
  DATA_DELETION: '서비스 데이터 삭제', ACCOUNT_WITHDRAWAL: '회원탈퇴',
  DASHBOARD_AGGREGATE: '대시보드 집계 내보내기',
  CONTENT_PERFORMANCE: '콘텐츠 성과 내보내기',
  MASKED_USERS: '마스킹 사용자 목록 CSV',
  PII_RAW: '개인정보 원문 CSV',
}
const statuses: Record<string, string> = {
  PENDING: '대기', QUEUED: '접수', RUNNING: '처리 중', SCHEDULED: '예약', SENDING: '처리 중',
  COMPLETED: '완료', FAILED: '실패', PARTIAL_FAILED: '일부 실패',
  CANCELED: '취소', CANCEL_REQUESTED: '취소 요청',
}
const scopes: Record<string, string> = {
  SELECTED_USERS: '선정 사용자', SEGMENT: '저장된 세그먼트', ACCOUNT_FILE: '사용자 내보내기 파일',
  SERVICE_DATA: '서비스 데이터', ACCOUNT: '계정 및 서비스 데이터',
  DASHBOARD_FILTER: '대시보드 필터 범위', CONTENT_FILTER: '콘텐츠 성과 필터 범위',
  MASKED_USERS: '요청 시 확정한 사용자',
  PROFILE: '이메일·가입 프로필', ANSWERS: '선택한 회차의 원응답',
}
const stages: Record<string, string> = {
  GRACE_PERIOD: '탈퇴 유예 중', AWAITING_PURGE: '영구 삭제 대기',
  PURGE_RETRY_WAIT: '영구 삭제 재시도 대기', PURGE_REVIEW_REQUIRED: '영구 삭제 점검 필요', ...statuses,
}
const time = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'medium' })
const date = (value?: string) => value ? time.format(new Date(value)) : '—'
const options = (labels: Record<string, string>) => Object.entries(labels).map(([value, label]) => ({ value, label }))
const root = '/api/v1/admin/jobs'

async function read<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await adminFetch(path, { signal, cache: 'no-store' })
  if (response.ok) return response.json() as Promise<T>
  if (response.status === 401) throw new Error('다시 로그인해주세요.')
  if (response.status === 403) throw new Error('작업 조회 권한이 없습니다.')
  if (response.status === 404) throw new Error('조회 가능한 작업 기록이 없습니다.')
  if (response.status === 422) throw new Error('조회 기간은 최대 366일입니다. 시작일과 종료일을 확인해주세요.')
  throw new Error('작업을 불러오지 못했습니다.')
}

function status(job: Job) {
  return <Space wrap>
    <Tag>{job.stage ? stages[job.stage] ?? job.stage : statuses[job.status] ?? job.status}</Tag>
    {job.overdue && <Tag color="red">기한 초과</Tag>}
    {job.deadlineWarning && <Tag color="orange">처리 기한 1시간 이내</Tag>}
  </Space>
}

export default function AdminJobs({ operator, privacy, analyst, jobId }: {
  operator: boolean; privacy: boolean; analyst: boolean; jobId?: string
}) {
  const [form] = Form.useForm<Filters>()
  const [filters, setFilters] = useState<Filters>({})
  const [page, setPage] = useState(1)
  const [refresh, setRefresh] = useState(0)
  const [listRefresh, setListRefresh] = useState(0)
  const [data, setData] = useState<Page>()
  const [error, setError] = useState<string>()
  const [selected, setSelected] = useState(jobId)
  const [detail, setDetail] = useState<Job>()
  const [detailError, setDetailError] = useState<string>()
  const [actionError, setActionError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [cancelReason, setCancelReason] = useState<string>()
  const [retryReason, setRetryReason] = useState<string>()
  const retryRequest = useRef<{ jobId: string; reason: string; requeueCount?: number; key: string }>(undefined)
  const deletion = detail?.kind === 'DATA_DELETION' || detail?.kind === 'ACCOUNT_WITHDRAWAL'
  const visibleKinds = [
    ...(operator ? ['CAMPAIGN', 'BULK_TAG', 'MASKED_USERS'] : []),
    ...(privacy ? ['APP_EXPORT', 'DATA_DELETION', 'ACCOUNT_WITHDRAWAL', 'PII_RAW'] : []),
    ...(analyst ? ['DASHBOARD_AGGREGATE', 'CONTENT_PERFORMANCE'] : []),
  ]
  const kindOptions = options(kinds).filter(({ value }) => visibleKinds.includes(value))

  useEffect(() => {
    const abort = new AbortController()
    const query = new URLSearchParams({ page: String(page), size: String(pageSize) })
    for (const [key, value] of Object.entries(filters)) if (value) query.set(key, value)
    void read<Page>(root + '?' + query, abort.signal).then((result) => {
      if (abort.signal.aborted) return
      setError(undefined)
      const lastPage = Math.max(1, Math.ceil(result.total / pageSize))
      if (page > lastPage) {
        setData(undefined)
        setPage(lastPage)
        return
      }
      setData(result)
    }).catch((failure: Error) => {
      if (abort.signal.aborted) return
      setData(undefined)
      setError(failure.message)
    })
    return () => abort.abort()
  }, [filters, page, refresh, listRefresh])

  useEffect(() => {
    if (!selected) return
    const abort = new AbortController()
    let timer: number | undefined
    let wasPending = false
    async function load() {
      try {
        const result = await read<Job>(root + '/' + selected, abort.signal)
        if (abort.signal.aborted) return
        setDetail(result)
        if (['DASHBOARD_AGGREGATE', 'CONTENT_PERFORMANCE', 'MASKED_USERS'].includes(result.kind) &&
          ['QUEUED', 'RUNNING'].includes(result.status)) {
          wasPending = true
          timer = window.setTimeout(() => void load(), 5_000)
        } else if (wasPending) {
          setListRefresh((value) => value + 1)
        }
      } catch (failure) {
        if (!abort.signal.aborted) setDetailError(failure instanceof Error ? failure.message : '작업을 불러오지 못했습니다.')
      }
    }
    void load()
    return () => {
      abort.abort()
      window.clearTimeout(timer)
    }
  }, [selected, refresh])

  function reload() {
    setData(undefined)
    setError(undefined)
    setDetailError(undefined)
    setRefresh((value) => value + 1)
  }

  function apply(values: Filters) {
    setFilters({ ...values, actorId: values.actorId?.trim() })
    setPage(1)
    reload()
  }

  async function exportAction(action: 'download' | 'cancel' | 'retry') {
    if (!detail) return
    setBusy(true)
    setActionError(undefined)
    try {
      if (action === 'download') {
        const link = await exportWrite<{ url: string }>('/exports/' + detail.id + '/download', {})
        const anchor = document.createElement('a')
        anchor.href = link.url
        anchor.download = ''
        anchor.rel = 'noreferrer'
        anchor.click()
      } else if (action === 'retry') {
        const reason = retryReason?.trim() ?? ''
        const requeueCount = deletion ? detail.requeueCount ?? 0 : undefined
        if (retryRequest.current?.jobId !== detail.id || retryRequest.current.reason !== reason ||
          retryRequest.current.requeueCount !== requeueCount) {
          retryRequest.current = { jobId: detail.id, reason, requeueCount, key: crypto.randomUUID() }
        }
        const path = (deletion ? '/deletion-requests/' : '/jobs/') + detail.id + '/retry'
        await exportWrite(path, deletion ? { reason, expectedRequeueCount: requeueCount } : { reason }, retryRequest.current.key)
        retryRequest.current = undefined
        setRetryReason(undefined)
        setDetail(undefined)
        reload()
      } else {
        await exportWrite('/jobs/' + detail.id + '/cancel', { kind: detail.kind, reason: cancelReason })
        setCancelReason(undefined)
        reload()
      }
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : '작업을 처리하지 못했습니다.')
    } finally {
      setBusy(false)
    }
  }

  return <Card id="job-monitor" title="작업 모니터" extra={<Button onClick={reload}>목록 갱신</Button>}>
    <Space orientation="vertical" style={{ display: 'flex' }}>
      <Form<Filters> form={form} layout="vertical" onFinish={apply}>
        <div className="admin-user-filters">
          <Form.Item name="kind" label="작업 종류"><Select allowClear options={kindOptions} /></Form.Item>
          <Form.Item name="status" label="상태"><Select allowClear options={options(statuses)} /></Form.Item>
          {(operator || analyst) && <Form.Item name="actorId" label="요청 관리자 ID" rules={[{
            pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
            message: '관리자 ID의 UUID 형식을 확인해주세요.',
          }]}><Input allowClear /></Form.Item>}
          <Form.Item name="from" label="조회 시작일 (KST)"><Input type="date" /></Form.Item>
          <Form.Item name="to" label="조회 종료일 (KST)"><Input type="date" /></Form.Item>
        </div>
        <Space>
          <Button type="primary" htmlType="submit">조회</Button>
          <Button onClick={() => { form.resetFields(); apply({}) }}>초기화</Button>
        </Space>
      </Form>
      {error && <Alert type="error" showIcon title={error} />}
      <Table<Job> rowKey="id" dataSource={data?.items ?? []} loading={!data && !error} scroll={{ x: 920 }}
        pagination={{ current: page, pageSize, total: data?.total ?? 0, showSizeChanger: false, onChange: (next) => {
          setData(undefined)
          setError(undefined)
          setPage(next)
        } }}
        columns={[
          { title: '작업 종류', render: (_, row) => kinds[row.kind] ?? row.kind },
          { title: '대상 범위', render: (_, row) => scopes[row.scope] ?? row.scope },
          { title: '상태', render: (_, row) => status(row) },
          { title: '요청 시각 (KST)', render: (_, row) => date(row.requestedAt) },
          { title: '진행', render: (_, row) => row.total ? row.processed + ' / ' + row.total : '—' },
          { title: '작업 ID', render: (_, row) => <Button type="link" onClick={() => {
            setDetail(undefined)
            setDetailError(undefined)
            setActionError(undefined)
            setSelected(row.id)
          }}>{row.id}</Button> },
        ]} />
    </Space>
    <Modal title="작업 상세" open={selected != null} onCancel={() => { setSelected(undefined); setCancelReason(undefined); setRetryReason(undefined) }}
      footer={null} width={680}>
      {detailError ? <Alert type="error" title={detailError}
        action={<Button size="small" onClick={reload}>다시 조회</Button>} /> : !detail ? <Typography.Text>불러오는 중</Typography.Text> :
        <Space orientation="vertical" style={{ display: 'flex' }}>
        <Descriptions bordered size="small" column={{ xs: 1, md: 2 }} items={[
          { key: 'id', label: '작업 ID', span: 'filled', children: <Typography.Text copyable>{detail.id}</Typography.Text> },
          { key: 'kind', label: '종류', children: kinds[detail.kind] ?? detail.kind },
          { key: 'status', label: '상태', children: status(detail) },
          { key: 'scope', label: '대상 범위', children: scopes[detail.scope] ?? detail.scope },
          { key: 'actor', label: '요청 관리자 ID', children: detail.actorId ?? '—' },
          { key: 'request', label: '요청 (KST)', children: date(detail.requestedAt) },
          { key: 'start', label: '시작 (KST)', children: date(detail.startedAt) },
          { key: 'complete', label: '완료 (KST)', children: date(detail.completedAt) },
          { key: 'due', label: '처리 기한 (KST)', children: date(detail.dueAt) },
          { key: 'expiry', label: '파일 만료 (KST)', children: date(detail.expiresAt) },
          { key: 'progress', label: '진행', children: detail.total ? detail.processed + ' / ' + detail.total : '—' },
          { key: 'retry', label: '재시도', children: detail.retryCount },
          ...(deletion ? [{ key: 'requeue', label: '운영자 재접수', children: detail.requeueCount ?? 0 }] : []),
          ...(detail.nextRunAt ? [{ key: 'next-run', label: '다음 시도 (KST)', children: date(detail.nextRunAt) }] : []),
          { key: 'error', label: '오류 코드', children: detail.errorCode ?? '—' },
        ]} />
        {['DASHBOARD_AGGREGATE', 'CONTENT_PERFORMANCE', 'MASKED_USERS'].includes(detail.kind) && detail.status === 'COMPLETED' && !detail.errorCode
          && <Button type="primary" loading={busy} onClick={() => void exportAction('download')}>
            {detail.kind === 'MASKED_USERS' ? '사용자 목록 CSV 다운로드' : '집계 파일 다운로드'}
          </Button>}
        {((detail.kind === 'PII_RAW' && detail.status === 'QUEUED') ||
          (['DASHBOARD_AGGREGATE', 'CONTENT_PERFORMANCE', 'MASKED_USERS'].includes(detail.kind) && ['QUEUED', 'RUNNING'].includes(detail.status))) && (cancelReason == null
          ? <Button danger onClick={() => setCancelReason('')}>내보내기 취소</Button>
          : <Space orientation="vertical" style={{ display: 'flex' }}>
            <Input.TextArea aria-label="취소 사유" placeholder="취소 사유" value={cancelReason} maxLength={500}
              onChange={(event) => setCancelReason(event.target.value)} />
            <Space>
              <Button danger loading={busy} disabled={!cancelReason.trim()}
                onClick={() => void exportAction('cancel')}>취소 확인</Button>
              <Button disabled={busy} onClick={() => setCancelReason(undefined)}>돌아가기</Button>
            </Space>
          </Space>)}
        {detail.retryable && detail.status === 'FAILED' && (!deletion || privacy) && (retryReason == null
          ? <Button type="primary" onClick={() => setRetryReason('')}>{deletion ? '삭제 작업 재접수' : '작업 재시도'}</Button>
          : <Space orientation="vertical" style={{ display: 'flex' }}>
            {deletion && <Typography.Text>실패 원인을 확인한 뒤 재접수하세요. 사유에는 개인정보를 입력하지 마세요.</Typography.Text>}
            <Input.TextArea aria-label="재시도 사유" placeholder="재시도 사유" value={retryReason} maxLength={500}
              onChange={(event) => setRetryReason(event.target.value)} />
            <Space>
              <Button type="primary" loading={busy} disabled={!retryReason.trim()}
                onClick={() => void exportAction('retry')}>{deletion ? '재접수 확인' : '재시도 확인'}</Button>
              <Button disabled={busy} onClick={() => setRetryReason(undefined)}>돌아가기</Button>
            </Space>
          </Space>)}
        {actionError && <Alert type="error" title={actionError} />}
        </Space>}
    </Modal>
  </Card>
}
