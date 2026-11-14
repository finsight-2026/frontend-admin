import { useAdminUnsaved } from './adminNavigation'
import { adminFetch } from './adminFetch'
import { Alert, Button, Card, Checkbox, Col, Form, Input, InputNumber, Row, Select, Space, Table, Tag, Typography } from 'antd'
import { useEffect, useRef, useState } from 'react'

type Kind = 'NOTICE' | 'GUIDE' | 'INSIGHT'
type Fields = {
  title: string; summary: string; body: string; sortOrder: number
  types?: string[]; todayAction?: string; nextAction?: string; guideCategory?: 'START' | 'LEARN'
  snapshotId?: string; metricKey?: string; insightExplanation?: string
}
type EditorFields = Fields & { source?: string }
type Source = { snapshotId: string; type: keyof typeof guideTypes; metricKey: string; from: string; to: string }
type Notice = Fields & {
  id: string; revisionId: string; revisionNo: number; authorId: string | null; status: Status
  publishedRevisionId?: string; startsAt?: string; endsAt?: string; version: number
  updatedAt: string; updatedByName?: string | null; publishedRevisionNo?: number | null; reviewReason?: string
}
type Status = 'DRAFT' | 'IN_REVIEW' | 'APPROVED' | 'SCHEDULED' | 'PUBLISHED' | 'UNPUBLISHED' | 'EXPIRED' | 'ARCHIVED'
type Action = 'SUBMIT' | 'WITHDRAW' | 'APPROVE' | 'REJECT' | 'PUBLISH' | 'SCHEDULE' | 'CANCEL_SCHEDULE' | 'UNPUBLISH' | 'ARCHIVE'
type Transition = { reason?: string; startsAt?: string; endsAt?: string; serviceOnlyConfirmed?: boolean }
type Preview = Pick<Fields, 'title' | 'summary' | 'body' | 'todayAction' | 'nextAction' | 'metricKey' | 'insightExplanation'> & {
  metricValue?: number | Record<string, number> | null
}
type Editor = { item?: Notice; mode: 'NEW' | 'EDIT' | 'REVISION' }
type Filter = { type?: string; q?: string; status?: Status; authorId?: string; from?: string; to?: string }
type Page = { items: Notice[]; total: number; page: number; size: number }

const root = '/api/v1/admin/contents'
const guideTypes = {
  DEBT: '부채부담형', INCOME: '소득불안형', EMERGENCY_FUND: '비상자금취약형',
  FIXED_COST: '고정비압박형', FUTURE: '미래불안형', FAMILY: '부양부담형',
}
const metrics: Record<string, string> = {
  YFSI_MEAN: '평균 금융 스트레스', EXTERNAL_AREA_MEAN: '외부 부담 평균',
  RESOURCE_DOMAIN_MEAN: '대응자원 평균', PERCEIVED_STRESS_MEAN: '평균 체감 스트레스',
}
const guideTypeOptions = Object.entries(guideTypes).map(([value, label]) => ({ value, label }))
const statuses: Record<Status, string> = {
  DRAFT: '초안', IN_REVIEW: '검토 중', APPROVED: '승인', SCHEDULED: '예약',
  PUBLISHED: '게시', UNPUBLISHED: '비공개', EXPIRED: '만료', ARCHIVED: '보관',
}
const actions: Record<Action, string> = {
  SUBMIT: '검토 요청', WITHDRAW: '검토 회수', APPROVE: '승인', REJECT: '반려',
  PUBLISH: '즉시 게시', SCHEDULE: '예약 게시', CANCEL_SCHEDULE: '예약 취소', UNPUBLISH: '비공개', ARCHIVE: '보관',
}
const time = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short',
})
const kst = (value?: string) => value ? value + ':00+09:00' : undefined

async function checked(response: Response) {
  if (response.ok) return response
  const errors: Record<number, string> = {
    401: '다시 로그인해주세요.', 403: '이 콘텐츠를 변경할 권한이 없습니다.',
    404: '콘텐츠 버전을 찾을 수 없습니다.',
    409: '다른 관리자가 수정했어요. 최신 내용을 확인해 주세요.',
    422: '입력 길이와 게시 기간을 확인해주세요. 본문에는 HTML을 사용할 수 없습니다.',
  }
  throw new Error(errors[response.status] ?? '콘텐츠 요청에 실패했습니다.')
}

async function write(path: string, method: string, body: object, key?: string) {
  const csrf = await adminFetch('/api/v1/admin/auth/csrf').then(checked)
    .then((response) => response.json() as Promise<{ headerName: string; token: string }>)
  return adminFetch(root + path, {
    method, headers: {
      [csrf.headerName]: csrf.token, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}),
    },
    body: JSON.stringify(body),
  }).then(checked)
}

function ContentPreview({ title, summary, body, todayAction, nextAction, metricKey, metricValue, insightExplanation }: Preview) {
  return <div>
    <Typography.Title level={4}>{title}</Typography.Title>
    <Typography.Text type="secondary">{summary}</Typography.Text>
    {body !== summary && <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{body}</Typography.Paragraph>}
    {metricKey && <Typography.Paragraph>
      <strong>{metrics[metricKey]}</strong>
      {' · '}
      {typeof metricValue === 'number' ? metricValue + '점' : metricValue
        ? Object.entries(metricValue).map(([key, value]) => (guideTypes[key as keyof typeof guideTypes] ?? key) + ' ' + value + '점').join(' · ')
        : '현재 표시할 승인 지표가 없어요.'}
    </Typography.Paragraph>}
    {insightExplanation && <Typography.Paragraph style={{ whiteSpace: 'pre-wrap' }}>{insightExplanation}</Typography.Paragraph>}
    {todayAction && <><Typography.Title level={5}>오늘의 행동</Typography.Title><Typography.Paragraph>{todayAction}</Typography.Paragraph></>}
    {nextAction && <><Typography.Title level={5}>다음 행동</Typography.Title><ol>
      {nextAction.split('\n').filter((step) => step.trim()).map((step, index) => <li key={index}>{step}</li>)}
    </ol></>}
  </div>
}

async function loadPreview(item: Notice, signal?: AbortSignal) {
  const base = root + '/' + item.id
  const previewUrl = (id: string) => base + '/preview?revisionId=' + encodeURIComponent(id)
  const currentPublished = item.publishedRevisionId && item.publishedRevisionId !== item.revisionId
  const readPreview = (id: string) => adminFetch(previewUrl(id), { signal }).then(checked)
    .then((response) => response.json() as Promise<Preview>)
  const [view, revisions, published] = await Promise.all([
    readPreview(item.revisionId),
    adminFetch(base + '/revisions', { signal }).then(checked).then((response) => response.json() as Promise<Notice[]>),
    currentPublished ? readPreview(item.publishedRevisionId!) : undefined,
  ])
  return { view, revisions, published }
}

export default function AdminNotices({ actorId, operator, supervisor, kind = 'NOTICE', selection }: {
  actorId: string; operator: boolean; supervisor: boolean; kind?: Kind
  selection?: { id: string; revision: number | null }
}) {
  const guide = kind === 'GUIDE'
  const insight = kind === 'INSIGHT'
  const title = guide ? '맞춤 가이드' : insight ? '행동 인사이트' : '서비스 공지'
  const [sources, setSources] = useState<Source[]>([])
  const sourceKey = (source: Pick<Source, 'snapshotId' | 'metricKey'>) => source.snapshotId + ':' + source.metricKey
  const [result, setResult] = useState<Page>()
  const [filters, setFilters] = useState<Filter>({})
  const [page, setPage] = useState(1)
  const [refresh, setRefresh] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [editor, setEditor] = useState<Editor>()
  const { mark: markUnsaved } = useAdminUnsaved(editor != null)
  const [selected, setSelected] = useState<Notice>()
  const [preview, setPreview] = useState<Preview>()
  const [published, setPublished] = useState<Preview>()
  const [revisions, setRevisions] = useState<Notice[]>([])
  const previewRef = useRef<HTMLElement>(null)
  const [action, setAction] = useState<Action>()
  const retry = useRef<{ body: string; key: string } | undefined>(undefined)
  const mutation = action === 'PUBLISH' || action === 'SCHEDULE'
  const needReason = action === 'REJECT' || action === 'UNPUBLISH'
    || ((action === 'APPROVE' || mutation) && selected?.authorId === actorId)

  useEffect(() => {
    const abort = new AbortController()
    const params = new URLSearchParams({ kind, page: String(page) })
    if ((guide || insight) && filters.type) params.set('type', filters.type)
    if (filters.q?.trim()) params.set('q', filters.q.trim())
    if (filters.status) params.set('status', filters.status)
    if (filters.authorId?.trim()) params.set('authorId', filters.authorId.trim())
    if (filters.from) params.set('from', filters.from)
    if (filters.to) params.set('to', filters.to)
    void adminFetch(root + '/page?' + params, { signal: abort.signal }).then(checked)
      .then((response) => response.json() as Promise<Page>).then((rows) => {
        if (!abort.signal.aborted) setResult(rows)
      }).catch((failure: unknown) => {
        if (!abort.signal.aborted) setError(failure instanceof Error ? failure.message : '콘텐츠를 불러오지 못했습니다.')
      }).finally(() => {
        if (!abort.signal.aborted) setLoading(false)
      })
    return () => abort.abort()
  }, [filters, refresh, kind, guide, insight, page])

  const selectedKey = selection?.id
  const selectedRevision = selection?.revision
  useEffect(() => {
    if (!selectedKey) return
    const abort = new AbortController()
    const params = new URLSearchParams({ kind, key: selectedKey })
    if (selectedRevision != null) params.set('revision', String(selectedRevision))
    void adminFetch(root + '/lookup?' + params, { signal: abort.signal }).then(checked)
      .then((response) => response.json() as Promise<Notice>)
      .then(async (item) => {
        const details = await loadPreview(item, abort.signal)
        if (abort.signal.aborted) return
        setSelected(item)
        setPreview(details.view)
        setRevisions(details.revisions)
        setPublished(details.published)
      }).catch((failure: Error) => { if (!abort.signal.aborted) setError(failure.message) })
    return () => abort.abort()
  }, [kind, selectedKey, selectedRevision])

  useEffect(() => {
    if (preview && selectedKey) previewRef.current?.focus()
  }, [preview, selectedKey])

  useEffect(() => {
    if (!insight || !operator) return
    const abort = new AbortController()
    void adminFetch(root + '/insight-sources', { signal: abort.signal }).then(checked)
      .then((response) => response.json() as Promise<Source[]>)
      .then((rows) => { if (!abort.signal.aborted) setSources(rows) })
      .catch((failure: Error) => { if (!abort.signal.aborted) setError(failure.message) })
    return () => abort.abort()
  }, [insight, operator, refresh])

  function reload() {
    setLoading(true)
    setError(undefined)
    setRefresh((value) => value + 1)
  }

  async function perform(work: () => Promise<void>) {
    setError(undefined)
    setBusy(true)
    try { await work() } catch (failure) {
      setError(failure instanceof Error ? failure.message : '콘텐츠 요청에 실패했습니다.')
    } finally { setBusy(false) }
  }

  function open(item: Notice) {
    setEditor(undefined)
    setSelected(item)
    setPreview(undefined)
    setPublished(undefined)
    setAction(undefined)
    void perform(async () => {
      const details = await loadPreview(item)
      setPreview(details.view)
      setRevisions(details.revisions)
      setPublished(details.published)
    })
  }

  async function save({ source, ...input }: EditorFields) {
    if (!editor) return
    const selectedSource = sources.find((item) => sourceKey(item) === source)
    if (insight && !selectedSource) {
      setError('현재 승인된 스냅샷과 지표를 선택해 주세요.')
      return
    }
    const fields = selectedSource ? {
      ...input, snapshotId: selectedSource.snapshotId, metricKey: selectedSource.metricKey, types: [selectedSource.type],
    } : input
    await perform(async () => {
      if (editor.mode === 'EDIT' && editor.item) {
        await write('/' + editor.item.id + '/draft', 'PATCH', {
          revisionId: editor.item.revisionId, expectedVersion: editor.item.version, fields,
        })
      } else {
        await write('', 'POST', { kind, contentId: editor.item?.id, fields })
      }
      setEditor(undefined)
      setSelected(undefined)
      reload()
    })
  }

  async function confirm(values: Transition) {
    if (!selected || !action || !preview) return
    await perform(async () => {
      const input = {
        revisionId: selected.revisionId, expectedVersion: selected.version, action, reason: values.reason,
        startsAt: kst(values.startsAt), endsAt: kst(values.endsAt), serviceOnlyConfirmed: values.serviceOnlyConfirmed ?? false,
      }
      const body = JSON.stringify(input)
      if (retry.current?.body !== body) retry.current = { body, key: crypto.randomUUID() }
      await write('/' + selected.id + '/transitions', 'POST', input, retry.current.key)
      setSelected(undefined)
      setAction(undefined)
      reload()
    })
  }

  const allowed: Action[] = []
  if (selected && operator && selected.authorId === actorId) {
    if (selected.status === 'DRAFT') allowed.push('SUBMIT', 'ARCHIVE')
    if (selected.status === 'IN_REVIEW') allowed.push('WITHDRAW')
  }
  if (selected && supervisor) {
    if (selected.status === 'IN_REVIEW') allowed.push('APPROVE', 'REJECT')
    if (selected.status === 'APPROVED') allowed.push('PUBLISH', 'SCHEDULE')
    if (selected.status === 'SCHEDULED') allowed.push('CANCEL_SCHEDULE')
    if (selected.status === 'PUBLISHED') allowed.push('UNPUBLISH')
    if (selected.status === 'UNPUBLISHED' || selected.status === 'EXPIRED') allowed.push('ARCHIVE')
  }

  return <Card title={title} extra={<Space>
    <Button disabled={busy} loading={loading} onClick={reload}>목록 갱신</Button>
    {operator && <Button type="primary" disabled={busy} onClick={() => {
      setSelected(undefined); setEditor({ mode: 'NEW' })
    }}>{guide ? "가이드 작성" : insight ? "인사이트 작성" : "공지 작성"}</Button>}
  </Space>}>
    <Space orientation="vertical" style={{ display: 'flex' }}>
      {error && <Alert type="error" showIcon title={error} />}
      <Form<Filter> layout="vertical" onFinish={(next) => { setError(undefined); setLoading(true); setFilters(next); setPage(1) }}>
        <div className="admin-user-filters">
          <Form.Item name="q" label="제목"><Input allowClear maxLength={80} /></Form.Item>
          {(guide || insight) && <Form.Item name="type" label="대상 유형"><Select allowClear options={guideTypeOptions} /></Form.Item>}
          <Form.Item name="status" label="상태"><Select allowClear
            options={Object.entries(statuses).map(([value, label]) => ({ value, label }))} /></Form.Item>
          <Form.Item name="authorId" label="작성자 ID"><Input allowClear /></Form.Item>
          <Form.Item name="from" label="수정 시작일 (KST)"><Input type="date" /></Form.Item>
          <Form.Item name="to" label="수정 종료일 (KST)"><Input type="date" /></Form.Item>
        </div>
        <Button htmlType="submit">검색</Button>
      </Form>
      <Table<Notice> rowKey="revisionId" dataSource={result?.items ?? []} loading={loading} scroll={{ x: 1000 }}
        pagination={{ pageSize: 20, current: page, total: result?.total ?? 0, showSizeChanger: false, onChange: (next) => {
          if (next === page) return
          setLoading(true); setError(undefined); setPage(next)
        } }} columns={[
          { title: '제목', dataIndex: 'title' },
          { title: '작업 버전', dataIndex: 'revisionNo' },
          { title: '공개 버전', render: (_, row) => row.publishedRevisionNo ?? '—' },
          { title: '상태', render: (_, row) => <Tag>{statuses[row.status]}</Tag> },
          { title: '공개 시작 (KST)', render: (_, row) => row.startsAt ? time.format(new Date(row.startsAt)) : '—' },
          { title: '공개 종료 (KST)', render: (_, row) => row.endsAt ? time.format(new Date(row.endsAt)) : '—' },
          { title: '수정자', render: (_, row) => row.updatedByName ?? '—' },
          { title: '작업', render: (_, row) => <Button disabled={busy} onClick={() => open(row)}>상세·미리보기</Button> },
        ]} />
      {editor && <Card size="small" title={editor.mode === 'EDIT' ? '초안 수정' : title + ' 초안'}>
        <Form<EditorFields> onValuesChange={markUnsaved} key={editor.mode + (editor.item?.revisionId ?? '')} layout="vertical"
          initialValues={editor.item ? { ...editor.item, source: editor.item.snapshotId && editor.item.metricKey
            ? sourceKey({ snapshotId: editor.item.snapshotId, metricKey: editor.item.metricKey }) : undefined }
            : { sortOrder: 0, guideCategory: guide ? 'START' : undefined }} onFinish={save} disabled={busy}>
          <Form.Item name="title" label="제목" rules={[{ required: true, whitespace: true }]}><Input maxLength={80} /></Form.Item>
          <Form.Item name="summary" label="요약" rules={[{ required: true, whitespace: true }]}><Input.TextArea maxLength={300} /></Form.Item>
          <Form.Item name="body" label="본문" rules={[{ required: true, whitespace: true }]}>
            <Input.TextArea maxLength={10000} autoSize={{ minRows: 5 }} />
          </Form.Item>
          {guide && <>
            <Form.Item name="types" label="대상 유형" rules={[{ required: true, type: 'array', min: 1 }]}>
              <Select mode="multiple" options={guideTypeOptions} />
            </Form.Item>
            <Form.Item name="guideCategory" label="가이드 분류" rules={[{ required: true }]}>
              <Select options={[{ value: 'START', label: '시작하기' }, { value: 'LEARN', label: '알아보기' }]} />
            </Form.Item>
            <Form.Item name="todayAction" label="오늘의 행동" rules={[{ required: true, whitespace: true }]}><Input maxLength={200} /></Form.Item>
            <Form.Item name="nextAction" label="다음 행동" extra="행동을 한 줄에 하나씩 입력해 주세요."
              rules={[{ required: true, whitespace: true }]}><Input.TextArea maxLength={1000} /></Form.Item>
          </>}
          {insight && <>
            <Form.Item name="source" label="승인 스냅샷과 지표" rules={[{ required: true }]}>
              <Select showSearch={{ optionFilterProp: 'label' }} options={sources.map((source) => ({
                value: sourceKey(source), label: guideTypes[source.type] + ' · ' + metrics[source.metricKey]
                  + ' · ' + source.from + ' ~ ' + source.to + ' · ' + source.snapshotId.slice(0, 8),
              }))} />
            </Form.Item>
            <Form.Item name="insightExplanation" label="집계 설명" rules={[{ required: true, whitespace: true }]}>
              <Input.TextArea maxLength={1000} />
            </Form.Item>
          </>}
          <Form.Item name="sortOrder" label="정렬 순서" rules={[{ required: true }]}><InputNumber min={0} max={999} precision={0} /></Form.Item>
          <Space><Button type="primary" htmlType="submit" loading={busy}>초안 저장</Button>
            <Button onClick={() => setEditor(undefined)}>취소</Button></Space>
        </Form>
      </Card>}
      {selected && preview && !editor && <section ref={previewRef} tabIndex={-1} aria-label="앱 미리보기"><Card size="small" title="앱 미리보기">
        <Space orientation="vertical" style={{ display: 'flex' }}>
          <Select aria-label="미리볼 버전" value={selected.revisionId} disabled={busy} style={{ minWidth: 180 }}
            options={revisions.map((item) => ({ value: item.revisionId, label: '버전 ' + item.revisionNo + ' · ' + statuses[item.status] }))}
            onChange={(id) => { const item = revisions.find((row) => row.revisionId === id); if (item) open(item) }} />
          <Row gutter={[16, 16]}>
            <Col xs={24} md={published ? 12 : 24}><ContentPreview {...preview} /></Col>
            {published && <Col xs={24} md={12}><Card size="small" title={'현재 공개 버전 ' + selected.publishedRevisionNo}>
              <ContentPreview {...published} />
            </Card></Col>}
          </Row>
          {selected.reviewReason && <Alert type="warning" title="검토 사유" description={selected.reviewReason} />}
          <Space wrap>
            {operator && selected.status === 'DRAFT' && selected.authorId === actorId &&
              <Button disabled={busy} onClick={() => setEditor({ mode: 'EDIT', item: selected })}>초안 수정</Button>}
            {operator && !['DRAFT', 'IN_REVIEW', 'SCHEDULED'].includes(selected.status) &&
              <Button disabled={busy} onClick={() => setEditor({ mode: 'REVISION', item: selected })}>
                {selected.status === 'ARCHIVED' ? '보관본에서 새 초안' : '이 버전에서 새 초안'}
              </Button>}
            {allowed.map((item) => <Button key={item} disabled={busy} onClick={() => setAction(item)}>{actions[item]}</Button>)}
            <Button disabled={busy} onClick={() => setSelected(undefined)}>닫기</Button>
          </Space>
          {action && <Form<Transition> key={action} layout="vertical" onFinish={confirm} disabled={busy}>
            {needReason && <Form.Item name="reason" label="사유" extra="개인정보를 입력하지 마세요." rules={[{ required: true, min: 10, max: 500, whitespace: true }]}>
              <Input.TextArea maxLength={500} />
            </Form.Item>}
            {action === 'SCHEDULE' && <Form.Item name="startsAt" label="공개 시작 (KST)" rules={[{ required: true }]}>
              <Input type="datetime-local" />
            </Form.Item>}
            {mutation && <>
              <Form.Item name="endsAt" label="공개 종료 (KST)"><Input type="datetime-local" /></Form.Item>
              <Form.Item name="serviceOnlyConfirmed" valuePropName="checked"
                rules={[{ validator: (_, value) => value === true ? Promise.resolve() : Promise.reject(new Error('미리보기 내용을 확인해주세요.')) }]}>
                <Checkbox>{(guide || insight) ? '미리보기와 대상 유형을 확인했습니다.' : '미리보기의 내용을 확인했으며 서비스 운영 안내에 해당합니다.'}</Checkbox>
              </Form.Item>
            </>}
            <Space><Button type="primary" htmlType="submit" loading={busy}>{actions[action]} 확인</Button>
              <Button onClick={() => setAction(undefined)}>취소</Button></Space>
          </Form>}
        </Space>
      </Card></section>}
    </Space>
  </Card>
}
