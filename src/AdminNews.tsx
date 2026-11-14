import { useAdminUnsaved } from './adminNavigation'
import { adminFetch } from './adminFetch'
import { Alert, Button, Card, Checkbox, Form, Input, Select, Space, Table } from 'antd'
import { useEffect, useRef, useState, type ChangeEvent } from 'react'

type Fields = {
  sourceUrl: string; title: string; summary: string; body: string; reason: string
  action: string; articlePublishedAt: string; types: string[]
  mediaId?: string | null
}
type Article = Fields & {
  id: string; revision: number; version: number; authorId: string; status: string; publishedRevision: number | null
  startsAt?: string | null; endsAt?: string | null; updatedByName?: string | null
}
type Review = { action: string; reason?: string; startsAt?: string; endsAt?: string; previewConfirmed?: boolean }
type Edition = { date: string; type: string; slots: string[] }
type Filter = { q?: string; status?: string; authorId?: string; type?: string; from?: string; to?: string }
type Page = { items: Article[]; total: number; page: number; size: number }
type EditionSlot = { slot: number; contentId: string; revisionId: number | null }
type EditionOption = { contentId: string; revisionId: number; title: string; status: string }
type EditionChoices = { options: EditionOption[]; slots: EditionSlot[]; version: number }
type Candidate = { sourceUrl: string; title: string; articlePublishedAt: string; collectedAt: string }
type CandidateInbox = {
  items: Candidate[]
  collection?: { status: string; attempts: number; nextRunAt?: string; acceptedCount: number } | null
}

const root = '/api/v1/admin/news'
const editionRoot = '/api/v1/admin/news-editions'
const types = {
  DEBT: '부채부담형', INCOME: '소득불안형', EMERGENCY_FUND: '비상자금취약형',
  FIXED_COST: '고정비압박형', FUTURE: '미래불안형', FAMILY: '부양부담형',
}
const typeOptions = Object.entries(types).map(([value, label]) => ({ value, label }))
const statuses: Record<string, string> = {
  DRAFT: '초안', IN_REVIEW: '검토 중', APPROVED: '승인', SCHEDULED: '예약', PUBLISHED: '게시',
  UNPUBLISHED: '비공개', EXPIRED: '만료', ARCHIVED: '보관',
}
const kstTime = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short' })
const asKst = (value: string) => value + ':00+09:00'
const toKstInput = (value: string) => new Date(new Date(value).valueOf() + 32_400_000).toISOString().slice(0, 16)
const revisionKey = (item: Article) => item.id + '/' + item.revision
const editionKey = (item: Pick<EditionSlot, 'contentId' | 'revisionId'>) => item.contentId + '/' + (item.revisionId ?? 'legacy')

async function decode<T>(response: Response): Promise<T> {
  if (response.ok) return response.json() as Promise<T>
  const messages: Record<number, string> = {
    401: '다시 로그인해주세요.', 403: '이 작업을 할 권한이 없습니다.',
    409: '기사 상태가 바뀌었거나 이미 등록된 기사입니다.', 422: '입력값과 기사 편성 조건을 확인해주세요.',
  }
  throw new Error(messages[response.status] ?? '뉴스 요청을 완료하지 못했습니다.')
}

async function write<T>(path: string, method: string, body: object, key?: string) {
  const csrf = await adminFetch('/api/v1/admin/auth/csrf').then(decode<{ token: string; headerName: string }>)
  return adminFetch(path, {
    method,
    headers: { [csrf.headerName]: csrf.token, 'Content-Type': 'application/json',
      ...(key ? { 'Idempotency-Key': key } : {}) },
    body: JSON.stringify(body),
  }).then(decode<T>)
}

function NewsImage({ id }: { id: string }) {
  return <img src={'/api/v1/admin/media/' + id + '/file'} alt="기사 이미지 미리보기"
    style={{ display: 'block', maxWidth: '100%', maxHeight: 240, objectFit: 'contain' }} />
}

function NewsImageField({ id, value, onChange, onUploading }: {
  id?: string; value?: string | null; onChange?: (value: string | null) => void; onUploading: (busy: boolean) => void
}) {
  const [error, setError] = useState<string>()
  const [uploading, setUploading] = useState(false)

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || uploading) return
    setError(undefined)
    if (file.size > 10 * 1024 * 1024) {
      setError('이미지는 10MB까지 첨부할 수 있어요.')
      return
    }
    setUploading(true)
    onUploading(true)
    try {
      const csrf = await adminFetch('/api/v1/admin/auth/csrf').then(decode<{ token: string; headerName: string }>)
      const body = new FormData()
      body.set('file', file)
      const response = await adminFetch('/api/v1/admin/media', {
        method: 'POST', headers: { [csrf.headerName]: csrf.token }, body,
      })
      if (response.status === 413) throw new Error('이미지는 10MB까지 첨부할 수 있어요.')
      if (response.status === 422) throw new Error('4096×4096 이하의 JPG, PNG 또는 WebP 이미지를 선택해 주세요.')
      const image = await decode<{ mediaId: string; status: string }>(response)
      if (image.status !== 'READY') throw new Error('이미지 검증을 마치지 못했어요.')
      onChange?.(image.mediaId)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '이미지를 올리지 못했어요.')
    } finally {
      onUploading(false)
      setUploading(false)
    }
  }

  return <Space orientation="vertical">
    <input id={id} type="file" accept="image/jpeg,image/png,image/webp" disabled={uploading}
      onChange={(event) => void upload(event)} />
    {uploading && <span role="status">이미지를 확인하는 중이에요.</span>}
    {error && <Alert title={error} type="error" />}
    {value && <><NewsImage id={value} /><Button disabled={uploading} onClick={() => onChange?.(null)}>이미지 제거</Button></>}
  </Space>
}

export default function AdminNews({ actorId, operator, supervisor, selection }: {
  actorId: string; operator: boolean; supervisor: boolean; selection?: { id: string; revision: number | null }
}) {
  const [result, setResult] = useState<Page>()
  const [filters, setFilters] = useState<Filter>({})
  const [page, setPage] = useState(1)
  const [refreshCount, setRefreshCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [current, setCurrent] = useState<Article>()
  const [history, setHistory] = useState<Article[]>([])
  const [editionForm] = Form.useForm<Edition>()
  const date = Form.useWatch('date', editionForm)
  const type = Form.useWatch('type', editionForm)
  const [choices, setChoices] = useState<{ key: string; value: EditionChoices }>()
  const choicesKey = date + '/' + type
  const [editing, setEditing] = useState<'NEW' | 'EDIT' | 'REVISION'>()
  const [showCandidates, setShowCandidates] = useState(false)
  const [candidateInbox, setCandidateInbox] = useState<CandidateInbox>()
  const [candidate, setCandidate] = useState<Candidate>()
  const { mark: markUnsaved } = useAdminUnsaved(editing != null)
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string>()
  const [message, setMessage] = useState<string>()
  const retry = useRef<{ request: string; key: string } | undefined>(undefined)
  const own = current?.authorId === actorId
  const selectedId = selection?.id
  const selectedRevision = selection?.revision
  const currentId = current?.id
  const published = current && history.find((item) => item.id === current.id
    && item.revision === current.publishedRevision && item.revision !== current.revision)
  const editionReady = choices?.key === choicesKey
  const validEditionOptions = editionReady ? choices.value.options : []
  const editionOptions = [
    ...validEditionOptions.map((item) => ({ value: editionKey(item),
      label: `${item.title} · 버전 ${item.revisionId} · ${statuses[item.status] ?? item.status}` })),
    ...(editionReady ? choices.value.slots.filter((slot) => !validEditionOptions.some((item) => editionKey(item) === editionKey(slot)))
      .map((slot) => ({ value: editionKey(slot), label: slot.revisionId == null
        ? '이전 편성 · 버전 선택 필요'
        : `기존 슬롯 ${slot.slot} · 버전 ${slot.revisionId} · 재선택 필요` })) : []),
  ]
  const detailRef = useRef<HTMLElement>(null)
  const editorRef = useRef<HTMLElement>(null)

  function report(error: unknown) {
    setError(error instanceof Error ? error.message : '요청에 실패했습니다.')
  }

  function refresh() {
    setLoading(true)
    setRefreshCount((previous) => previous + 1)
  }

  useEffect(() => {
    const abort = new AbortController()
    const params = new URLSearchParams({ page: String(page) })
    for (const [name, value] of Object.entries(filters)) if (value?.trim()) params.set(name, value.trim())
    void adminFetch(root + '/page?' + params, { signal: abort.signal }).then(decode<Page>).then((list) => {
      if (!abort.signal.aborted) setResult(list)
    }).catch((error: unknown) => { if (!abort.signal.aborted) report(error) }).finally(() => {
      if (!abort.signal.aborted) setLoading(false)
    })
    return () => abort.abort()
  }, [filters, page, refreshCount])

  useEffect(() => {
    if (!showCandidates) return
    const abort = new AbortController()
    void adminFetch(root + '/candidates', { signal: abort.signal }).then(decode<CandidateInbox>).then((value) => {
      if (!abort.signal.aborted) setCandidateInbox(value)
    }).catch((failure: unknown) => { if (!abort.signal.aborted) report(failure) })
    return () => abort.abort()
  }, [showCandidates, refreshCount])

  useEffect(() => {
    if (editing === 'NEW' && candidate) editorRef.current?.focus()
  }, [editing, candidate])

  useEffect(() => {
    if (!selectedId) return
    const abort = new AbortController()
    const query = selectedRevision == null ? '' : '?revision=' + selectedRevision
    void adminFetch(root + '/' + selectedId + query, { signal: abort.signal }).then(decode<Article>).then((item) => {
      if (!abort.signal.aborted) setCurrent(item)
    }).catch((failure: unknown) => { if (!abort.signal.aborted) report(failure) })
    return () => abort.abort()
  }, [selectedId, selectedRevision])

  useEffect(() => {
    if (!currentId) return
    const abort = new AbortController()
    void adminFetch(root + '/' + currentId + '/revisions', { signal: abort.signal }).then(decode<Article[]>).then((rows) => {
      if (!abort.signal.aborted) setHistory(rows)
    }).catch((failure: unknown) => { if (!abort.signal.aborted) report(failure) })
    return () => abort.abort()
  }, [currentId, refreshCount])

  useEffect(() => {
    if (selectedId && currentId === selectedId) detailRef.current?.focus()
  }, [currentId, selectedId])

  useEffect(() => {
    if (!supervisor || !date || !type) return
    const abort = new AbortController()
    const params = new URLSearchParams({ date, type })
    void adminFetch(editionRoot + '?' + params, { signal: abort.signal }).then(decode<EditionChoices>).then((value) => {
      if (abort.signal.aborted) return
      setChoices({ key: choicesKey, value })
      editionForm.setFieldValue('slots', value.slots.map(editionKey))
    }).catch((failure: unknown) => { if (!abort.signal.aborted) report(failure) })
    return () => abort.abort()
  }, [supervisor, date, type, choicesKey, editionForm, refreshCount])

  async function run(operation: () => Promise<void>) {
    setBusy(true)
    setError(undefined)
    setMessage(undefined)
    try { await operation() } catch (error) { report(error) } finally { setBusy(false) }
  }

  async function save(values: Fields) {
    if (uploading) return
    const originalPublishedAt = editing === 'NEW' ? candidate?.articlePublishedAt : current?.articlePublishedAt
    const articlePublishedAt = originalPublishedAt && values.articlePublishedAt === toKstInput(originalPublishedAt)
      ? originalPublishedAt : asKst(values.articlePublishedAt)
    const fields = { ...values, articlePublishedAt }
    const item = editing === 'EDIT' && current
      ? await write<Article>(root + '/' + revisionKey(current), 'PATCH', { fields, expectedVersion: current.version })
      : await write<Article>(root, 'POST', { fields, articleId: editing === 'REVISION' ? current?.id : undefined })
    setEditing(undefined)
    setCandidate(undefined)
    setCurrent(item)
    refresh()
  }

  async function change(values: Review) {
    if (!current) return
    const url = root + '/' + revisionKey(current) + '/transitions'
    const request = JSON.stringify([url, current.version, values])
    if (retry.current?.request !== request) {
      retry.current = { request, key: crypto.randomUUID() }
    }
    const result = await write<Article>(url, 'POST', {
      action: values.action, expectedVersion: current.version, reason: values.reason,
      startsAt: values.action === 'SCHEDULE' && values.startsAt ? asKst(values.startsAt) : undefined,
      endsAt: ['PUBLISH', 'SCHEDULE'].includes(values.action) && values.endsAt ? asKst(values.endsAt) : undefined,
      previewConfirmed: values.previewConfirmed,
    }, retry.current.key)
    setCurrent(result)
    refresh()
  }

  const actions = [
    ...(operator && own && current?.status === 'DRAFT' ? [{ value: 'SUBMIT', label: '검토 요청' }] : []),
    ...(operator && own && current?.status === 'IN_REVIEW' ? [{ value: 'WITHDRAW', label: '검토 회수' }] : []),
    ...(supervisor && current?.status === 'IN_REVIEW'
      ? [{ value: 'APPROVE', label: '승인' }, { value: 'REJECT', label: '반려' }] : []),
    ...(supervisor && current?.status === 'APPROVED'
      ? [{ value: 'PUBLISH', label: '즉시 게시' }, { value: 'SCHEDULE', label: '예약 게시' }] : []),
    ...(supervisor && current?.status === 'SCHEDULED' ? [{ value: 'CANCEL_SCHEDULE', label: '예약 취소' }] : []),
    ...(supervisor && current?.status === 'PUBLISHED' ? [{ value: 'UNPUBLISH', label: '비공개' }] : []),
    ...((operator && own && current?.status === 'DRAFT') || (supervisor && ['UNPUBLISHED', 'EXPIRED'].includes(current?.status ?? ''))
      ? [{ value: 'ARCHIVE', label: '보관' }] : []),
  ]

  return (
    <Card id="news-editor" title="경제 뉴스 운영">
      <Space orientation="vertical" style={{ display: 'flex' }}>
        {error && <Alert title={error} type="error" />}
        {message && <Alert title={message} type="success" />}
        <Space wrap>
          {operator && <Button disabled={busy || uploading || editing != null} onClick={() => {
            setCandidate(undefined)
            setEditing('NEW')
          }}>새 기사 초안</Button>}
          <Button aria-expanded={showCandidates} onClick={() => setShowCandidates(!showCandidates)}>수집 후보</Button>
          <Button disabled={busy || uploading} loading={loading} onClick={() => { setError(undefined); refresh() }}>새로고침</Button>
        </Space>
        {showCandidates && <Card size="small" title="한국경제 수집 후보">
          {candidateInbox?.collection?.status === 'FAILED' && <Alert type="warning" title="오늘 후보를 수집하지 못했어요." />}
          {candidateInbox?.collection?.status === 'QUEUED' && <Alert type="warning" title="수집 재시도 대기 중"
            description={candidateInbox.collection.nextRunAt ? kstTime.format(new Date(candidateInbox.collection.nextRunAt)) : undefined} />}
          <Table<Candidate> rowKey="sourceUrl" size="small" dataSource={candidateInbox?.items ?? []}
            loading={!candidateInbox && !error} tableLayout="fixed" pagination={{ pageSize: 10, showSizeChanger: false }}
            locale={{ emptyText: '최근 72시간에 작성할 수 있는 후보가 없어요.' }} columns={[
              { title: '기사 · 발행 (KST)', render: (_, row) => <Space orientation="vertical" size={0}>
                <a href={row.sourceUrl} target="_blank" rel="noreferrer" style={{ overflowWrap: 'anywhere' }}>{row.title}</a>
                <time dateTime={row.articlePublishedAt}>{kstTime.format(new Date(row.articlePublishedAt))}</time>
              </Space> },
              ...(operator ? [{ title: '작업', width: 122, render: (_: unknown, row: Candidate) => <Button size="small"
                disabled={busy || uploading || editing != null} onClick={() => {
                  setCandidate(row)
                  setEditing('NEW')
                }}>후보로 초안 작성</Button> }] : []),
            ]} />
        </Card>}
        <Form<Filter> name="news-filter" layout="vertical" onFinish={(values) => {
          setError(undefined); setLoading(true); setFilters(values); setPage(1)
        }}>
          <div className="admin-user-filters">
            <Form.Item name="q" label="제목 검색"><Input allowClear maxLength={80} /></Form.Item>
            <Form.Item name="type" label="대상 유형 필터"><Select allowClear options={typeOptions} /></Form.Item>
            <Form.Item name="status" label="상태"><Select allowClear
              options={Object.entries(statuses).map(([value, label]) => ({ value, label }))} /></Form.Item>
            <Form.Item name="authorId" label="작성자 ID"><Input allowClear /></Form.Item>
            <Form.Item name="from" label="수정 시작일 (KST)"><Input type="date" /></Form.Item>
            <Form.Item name="to" label="수정 종료일 (KST)"><Input type="date" /></Form.Item>
          </div>
          <Button htmlType="submit">검색</Button>
        </Form>
        <Table<Article> rowKey={revisionKey} dataSource={result?.items ?? []} loading={loading} scroll={{ x: 1000 }}
          pagination={{ current: page, pageSize: 20, total: result?.total ?? 0, showSizeChanger: false, onChange: (next) => {
            if (next === page) return
            setError(undefined); setLoading(true); setPage(next)
          } }} columns={[
          { title: '기사', render: (_, item) => <Button type="link" disabled={busy || uploading} onClick={() => {
            setCurrent(item); setEditing(undefined); setCandidate(undefined)
          }}>{item.title}</Button> },
          { title: '작업 버전', dataIndex: 'revision' },
          { title: '상태', render: (_, row) => statuses[row.status] ?? row.status },
          { title: '공개 버전', dataIndex: 'publishedRevision', render: (value) => value ?? '—' },
          { title: '공개 시작 (KST)', render: (_, row) => row.startsAt ? kstTime.format(new Date(row.startsAt)) : '—' },
          { title: '공개 종료 (KST)', render: (_, row) => row.endsAt ? kstTime.format(new Date(row.endsAt)) : '—' },
          { title: '수정자', render: (_, row) => row.updatedByName ?? '—' },
        ]} />
        {current && !editing && <section ref={detailRef} tabIndex={-1} aria-label="뉴스 버전 미리보기">
          <Select aria-label="미리볼 뉴스 버전" value={current.revision} disabled={busy} style={{ minWidth: 180 }}
            options={history.filter((item) => item.id === current.id).map((item) => ({
              value: item.revision, label: '버전 ' + item.revision + ' · ' + (statuses[item.status] ?? item.status),
            }))}
            onChange={(revision) => {
              const item = history.find((row) => row.id === current.id && row.revision === revision)
              if (item) setCurrent(item)
            }} />
          <h3>{current.title}</h3>
          {current.mediaId && <NewsImage id={current.mediaId} />}
          <p>핵심 요약 · {current.summary}</p>
          <p style={{ whiteSpace: 'pre-wrap' }}>{current.body}</p>
          <p>관련 이유 · {current.reason}</p>
          <p>작은 행동 · {current.action}</p>
          {published && <Card size="small" title={'현재 공개 버전 ' + published.revision}>
            <h3>{published.title}</h3>
            {published.mediaId && <NewsImage id={published.mediaId} />}
            <p>{published.summary}</p>
            <p style={{ whiteSpace: 'pre-wrap' }}>{published.body}</p>
            <p>{published.reason}</p>
            <p>{published.action}</p>
          </Card>}
          <Space wrap>
            {operator && own && current.status === 'DRAFT' && <Button onClick={() => setEditing('EDIT')}>초안 수정</Button>}
            {operator && ['APPROVED', 'PUBLISHED', 'UNPUBLISHED', 'EXPIRED', 'ARCHIVED'].includes(current.status) &&
              <Button onClick={() => setEditing('REVISION')}>
                {current.status === 'ARCHIVED' ? '보관본에서 새 초안' : '새 수정본 작성'}
              </Button>}
          </Space>
          {actions.length > 0 && <Form<Review> key={revisionKey(current) + '-' + current.version} layout="vertical"
              onFinish={(values) => run(() => change(values))}>
            <div className="admin-user-filters">
              <Form.Item name="action" label="작업" rules={[{ required: true }]}><Select options={actions} /></Form.Item>
              <Form.Item name="reason" label="사유 (자기승인·자기게시·반려·비공개 시 필수)"><Input maxLength={500} /></Form.Item>
            </div>
            <Form.Item noStyle shouldUpdate={(previous, next) => previous.action !== next.action}>
              {({ getFieldValue }) => {
                const action = getFieldValue('action')
                if (action !== 'PUBLISH' && action !== 'SCHEDULE') return null
                return <>
                  <div className="admin-user-filters">
                    {action === 'SCHEDULE' && <Form.Item name="startsAt" label="공개 시작 (KST)" preserve={false}
                      rules={[{ required: true }]}><Input type="datetime-local" /></Form.Item>}
                    <Form.Item name="endsAt" label="공개 종료 (KST, 선택)" preserve={false}><Input type="datetime-local" /></Form.Item>
                  </div>
                  <Form.Item name="previewConfirmed" valuePropName="checked" preserve={false}
                    rules={[{ validator: (_, value) => value ? Promise.resolve() : Promise.reject(new Error('미리보기를 확인해 주세요.')) }]}>
                    <Checkbox>기사 미리보기와 대상 유형을 확인했습니다.</Checkbox>
                  </Form.Item>
                </>
              }}
            </Form.Item>
            <Button htmlType="submit" loading={busy}>작업 적용</Button>
          </Form>}
        </section>}
        {editing && <section ref={editorRef} tabIndex={-1} aria-label="기사 초안 편집"><Form<Fields>
            onValuesChange={markUnsaved} key={editing + (candidate?.sourceUrl ?? (current ? revisionKey(current) : ''))} layout="vertical"
            initialValues={editing !== 'NEW' && current ? {
              ...current, articlePublishedAt: toKstInput(current.articlePublishedAt),
            } : candidate ? {
              sourceUrl: candidate.sourceUrl, title: candidate.title, articlePublishedAt: toKstInput(candidate.articlePublishedAt),
            } : undefined} onFinish={(values) => run(() => save(values))}>
          <div className="admin-user-filters">
            <Form.Item name="sourceUrl" label="한국경제 원문 URL" rules={[{ required: true }]}><Input disabled={editing !== 'NEW'} /></Form.Item>
            <Form.Item name="title" label="기사 제목" rules={[{ required: true, max: 80 }]}><Input /></Form.Item>
            <Form.Item name="articlePublishedAt" label="기사 발행 (KST)" rules={[{ required: true }]}><Input type="datetime-local" /></Form.Item>
            <Form.Item name="types" label="대상 유형" rules={[{ required: true }]}><Select mode="multiple" options={typeOptions} /></Form.Item>
          </div>
          {([{ key: 'summary', label: '핵심 요약', max: 300 }, { key: 'body', label: '한눈에 보기', max: 10000 },
            { key: 'reason', label: '관련 이유', max: 300 }, { key: 'action', label: '작은 행동', max: 200 }] as const)
            .map(({ key, label, max }) => (
              <Form.Item key={key} name={key} label={label} rules={[{ required: true, max }]}>
                <Input.TextArea maxLength={max} />
              </Form.Item>
            ))}
          <Form.Item name="mediaId" label="기사 이미지">
            <NewsImageField onUploading={setUploading} />
          </Form.Item>
          <Space><Button htmlType="submit" type="primary" loading={busy} disabled={uploading}>초안 저장</Button>
            <Button disabled={busy || uploading} onClick={() => { setEditing(undefined); setCandidate(undefined) }}>취소</Button></Space>
        </Form></section>}
        {supervisor && <Form<Edition> name="news-edition" form={editionForm} layout="vertical" onValuesChange={(changed: Partial<Edition>) => {
          if ('date' in changed || 'type' in changed) editionForm.setFieldValue('slots', [])
        }} onFinish={(values) => run(async () => {
          if (!editionReady) return
          const selected = values.slots.map((value) => validEditionOptions.find((item) => editionKey(item) === value))
          if (selected.some((item) => item == null)) return
          const slots = selected.map((item, index) => ({ slot: index + 1, contentId: item!.contentId, revisionId: item!.revisionId }))
          const result = await write<Pick<EditionChoices, 'slots' | 'version'>>(
            editionRoot + '/' + values.date + '/' + values.type, 'PUT', { slots, expectedVersion: choices.value.version })
          setChoices({ key: choicesKey, value: { ...choices.value, ...result } })
          setMessage('선택한 순서대로 편성을 저장했습니다.')
        })}>
          <h3>날짜·유형별 뉴스 편성</h3>
          <div className="admin-user-filters">
            <Form.Item name="date" label="편성 날짜 (KST)" rules={[{ required: true }]}><Input type="date" /></Form.Item>
            <Form.Item name="type" label="유형" rules={[{ required: true }]}><Select options={typeOptions} /></Form.Item>
            <Form.Item name="slots" label="기사 버전 (선택 순서가 슬롯)" rules={[{ required: true },
              { validator: (_, values: string[] = []) => {
                const selected = values.map((value) => validEditionOptions.find((item) => editionKey(item) === value))
                if (selected.some((item) => !item)) return Promise.reject(new Error('편성 가능한 기사 버전을 다시 선택해 주세요.'))
                if (new Set(selected.map((item) => item?.contentId)).size !== selected.length) {
                  return Promise.reject(new Error('같은 기사는 한 번만 선택해 주세요.'))
                }
                return Promise.resolve()
              } }]}>
              <Select mode="multiple" allowClear maxCount={3} options={editionOptions} disabled={!editionReady} />
            </Form.Item>
          </div>
          <Button htmlType="submit" loading={busy} disabled={!editionReady}>편성 저장</Button>
        </Form>}
      </Space>
    </Card>
  )
}
