import { adminFetch } from './adminFetch'
import { Alert, Button, Card, Checkbox, Descriptions, Empty, Form, Input, Pagination, Select, Space, Spin, Table } from 'antd'
import { useCallback, useEffect, useMemo, useState } from 'react'
import AdminBulkTagPanel from './AdminBulkTagPanel'
import AdminUserNotes from './AdminUserNotes'
import AdminPiiPanel from './AdminPiiPanel'
import { TagCatalog, UserTagEditor, type Tag } from './AdminUserTags'
import { userIdPattern, userListQuery, type UserFilters } from './adminNavigation'

type User = {
  id: string
  maskedEmail: string
  createdAt: string
  status: 'ACTIVE' | 'WITHDRAWAL_PENDING'
  lastDiagnosisAt: string | null
  representativeType: string | null
  diagnosisCount: number
  tags: string[]
}
type DiagnosisSummary = { id: string; completedAt: string; representativeType: string }
type Consent = { documentKind: string; documentVersion: string; granted: boolean; recordedAt: string }
type Detail = { user: User; profile: Record<string, string>; consents: Consent[]; recentDiagnoses: DiagnosisSummary[] }
type Score = { numerator: number; denominator: number }
type Diagnosis = DiagnosisSummary & {
  surveyVersion: string; formulaVersion: string
  score: {
    total?: Score; perceivedStress?: Score; overallStress?: string
    rankedPressures?: { score: Score }[]; resources?: { score: Score }[]
  }
}
type Page = { items: User[]; total: number; size: number; page: number }
const badges: Record<string, string> = {
  DEBT: '부채부담형', INCOME: '소득불안형', EMERGENCY_FUND: '비상자금취약형',
  FIXED_COST: '고정비압박형', FUTURE: '미래불안형', FAMILY: '부양부담형',
}
const statuses = { ACTIVE: '활성', WITHDRAWAL_PENDING: '탈퇴 대기' }
const dates = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Seoul' })
const formatDate = (value: string | null) => value ? dates.format(new Date(value)) : '—'
const trimFilter = (value?: string) => value?.trim()
const formatScore = (score?: Score) => score && score.denominator > 0
  ? Math.round(score.numerator / score.denominator) + '점' : '—'
function formatCombined(areas: { score: Score }[] | undefined, questionCount: number) {
  const denominator = areas?.reduce((total, { score }) => total + score.denominator, 0)
  if (!areas || denominator !== questionCount) return '—'
  return formatScore({
    denominator,
    numerator: areas.reduce((total, { score }) => total + score.numerator, 0),
  })
}

async function get<T>(path: string, signal: AbortSignal) {
  const response = await adminFetch('/api/v1/admin/users' + path, { signal })
  if (!response.ok) {
    if (response.status === 401) throw new Error('세션이 만료되었습니다. 다시 로그인해주세요.')
    if (response.status === 403) throw new Error('이 정보를 조회할 권한이 없습니다.')
    if (response.status === 404) throw new Error('선택한 기록을 찾을 수 없습니다.')
    if (response.status === 400 || response.status === 422) throw new Error('검색 조건을 확인해주세요.')
    throw new Error('요청을 완료하지 못했습니다.')
  }
  return response.json() as Promise<T>
}

export default function AdminUsers({ actorId, operator, supervisor, privacy, userId: selected, search, onSelect }: {
  actorId: string; operator: boolean; supervisor: boolean; privacy: boolean
  userId?: string; search: string; onSelect: (id?: string, query?: URLSearchParams) => void
}) {
  const { filters, page } = useMemo(() => {
    const query = userListQuery(search)
    const page = Number(query.get('page') ?? 1)
    query.delete('page')
    const filters: UserFilters = { ...Object.fromEntries(query), includeNoDiagnosis: query.has('includeNoDiagnosis') }
    return { filters, page }
  }, [search])
  const [loadedList, setList] = useState<{ search: string; value: Page }>()
  const list = loadedList?.search === search ? loadedList.value : undefined
  const [loadedDetail, setDetail] = useState<Detail>()
  const [selectedDiagnosis, setDiagnosisId] = useState<{ owner: string; id: string }>()
  const [loadedDiagnosis, setDiagnosis] = useState<Diagnosis>()
  const detail = loadedDetail?.user.id === selected ? loadedDetail : undefined
  const diagnosisId = selectedDiagnosis?.owner === selected ? selectedDiagnosis?.id : undefined
  const diagnosis = loadedDiagnosis?.id === diagnosisId ? loadedDiagnosis : undefined
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [tags, setTags] = useState<Tag[]>([])
  const [tagRevision, setTagRevision] = useState(0)
  const [dataRevision, setDataRevision] = useState(0)
  const [checked, setChecked] = useState<string[]>([])
  const refreshUsers = useCallback(() => setDataRevision((value) => value + 1), [])
  const [selectionSearch, setSelectionSearch] = useState(search)
  const currentSelection = selectionSearch === search ? checked.filter((id) => list?.items.some((user) => user.id === id)) : []

  useEffect(() => {
    if (!operator) return
    const abort = new AbortController()
    void adminFetch('/api/v1/admin/tags', { signal: abort.signal }).then(async (response) => {
      if (!response.ok) throw new Error('태그 목록을 불러오지 못했습니다.')
      return response.json() as Promise<Tag[]>
    }).then((items) => {
      if (!abort.signal.aborted) setTags(items)
    }).catch((failure: Error) => {
      if (!abort.signal.aborted) setError(failure.message)
    })
    return () => abort.abort()
  }, [operator, tagRevision])

  useEffect(() => {
    if (selected) return
    const abort = new AbortController()
    const params = new URLSearchParams({ page: String(page) })
    for (const [key, value] of Object.entries(filters)) {
      if (typeof value === 'string' && value.trim()) params.set(key, value.trim())
      if (value === true) params.set(key, 'true')
    }
    get<Page>('?' + params, abort.signal).then((value) => {
      if (!abort.signal.aborted) setList({ search, value })
    }).catch((error: Error) => {
      if (!abort.signal.aborted) setError(error.message)
    }).finally(() => { if (!abort.signal.aborted) setLoading(false) })
    return () => abort.abort()
  }, [filters, page, search, dataRevision, selected])

  useEffect(() => {
    if (!selected) return
    const abort = new AbortController()
    get<Detail>('/' + selected, abort.signal).then((result) => {
      if (!abort.signal.aborted) setDetail(result)
    }).catch((error: Error) => {
      if (!abort.signal.aborted) setError(error.message)
    })
    return () => abort.abort()
  }, [selected, dataRevision])

  useEffect(() => {
    if (!selected || !diagnosisId) return
    const abort = new AbortController()
    get<Diagnosis>('/' + selected + '/diagnoses/' + diagnosisId, abort.signal)
      .then((result) => { if (!abort.signal.aborted) setDiagnosis(result) }).catch((error: Error) => {
        if (!abort.signal.aborted) setError(error.message)
      })
    return () => abort.abort()
  }, [selected, diagnosisId])

  function selectUser(id?: string) {
    setError(undefined)
    onSelect(id)
  }

  function applyFilters(values: UserFilters, nextPage: number) {
    const query = new URLSearchParams({ page: String(nextPage) })
    for (const [key, value] of Object.entries(values)) {
      if (typeof value === 'string' && value.trim()) query.set(key, value.trim())
      if (value === true) query.set(key, 'true')
    }
    setError(undefined)
    setLoading(true)
    setChecked([])
    if (userListQuery(query.toString()).toString() === search.replace(/^\?/, '')) refreshUsers()
    else onSelect(undefined, query)
  }

  return (
    <Card title={selected ? '사용자 상세' : '사용자 목록'}>
      {error && <Alert title={error} type="error" showIcon />}
      {selected ? (
        <Space orientation="vertical" style={{ display: 'flex' }}>
          <Button onClick={() => selectUser()}>목록으로</Button>
          {!detail && !error && <Spin />}
          {detail && <>
            <Descriptions bordered column={1} items={[
              { key: 'id', label: '사용자 ID', children: detail.user.id },
              { key: 'email', label: '이메일', children: detail.user.maskedEmail },
              { key: 'status', label: '계정 상태', children: statuses[detail.user.status] },
              { key: 'age', label: '연령대', children: detail.profile.age?.replace('_', '–').replace('30_PLUS', '30 이상') ?? '—' },
              { key: 'count', label: '완료 진단', children: detail.user.diagnosisCount },
              { key: 'tags', label: '태그', children: detail.user.tags.join(', ') || '—' },
            ]} />
            <h3>동의 이력</h3>
            {detail.consents.length === 0 ? <Empty description="동의 기록 없음" /> : detail.consents.map((consent) => (
              <div key={consent.documentKind + consent.documentVersion + consent.recordedAt}>
                {consent.documentKind} · {consent.granted ? '동의' : '미동의'} · {consent.documentVersion} · {formatDate(consent.recordedAt)}
              </div>
            ))}
            {operator && <UserTagEditor key={'tags-' + selected} userId={selected} tags={tags}
              changed={() => setDataRevision((value) => value + 1)} />}
            {operator && <AdminUserNotes key={selected} userId={selected} actorId={actorId} supervisor={supervisor} />}
            <h3>최근 완료 진단 (KST)</h3>
            {detail.recentDiagnoses.length === 0 ? <Empty description="완료 진단 없음" /> : (
              <Select aria-label="진단 회차 선택" placeholder="회차 선택" value={diagnosisId} onChange={(id) => {
                setError(undefined)
                setDiagnosis(undefined)
                setDiagnosisId({ owner: selected, id })
              }} style={{ width: '100%' }} options={detail.recentDiagnoses.map((item) => ({
                value: item.id, label: formatDate(item.completedAt) + ' · ' + (badges[item.representativeType] ?? '—'),
              }))} />
            )}
            {diagnosisId && !diagnosis && !error && <Spin />}
            {diagnosis && <Descriptions bordered column={1} items={[
              { key: 'score', label: '금융 스트레스 점수', children: formatScore(diagnosis.score.total) },
              { key: 'stress', label: '체감 스트레스', children: formatScore(diagnosis.score.perceivedStress) },
              { key: 'pressure', label: '외부 압박 종합 (Q1~17)', children: formatCombined(diagnosis.score.rankedPressures, 17) },
              { key: 'resource', label: '대응자원 종합 (Q18~26)', children: formatCombined(diagnosis.score.resources, 9) },
              { key: 'type', label: '대표 유형', children: badges[diagnosis.representativeType] ?? '—' },
              { key: 'version', label: '설문 · 산식 버전', children: diagnosis.surveyVersion + ' · ' + diagnosis.formulaVersion },
            ]} />}
            {privacy && <AdminPiiPanel key={selected + '/' + (diagnosisId ?? '')} userId={selected} diagnosisId={diagnosisId} />}
          </>}
        </Space>
      ) : (
        <Space orientation="vertical" style={{ display: 'flex' }}>
          {operator && <TagCatalog tags={tags} changed={() => {
            setTagRevision((value) => value + 1)
            setDataRevision((value) => value + 1)
          }} />}
          <Form<UserFilters> key={search} layout="vertical" initialValues={filters} onFinish={(values) => applyFilters(values, 1)}>
            <div className="admin-user-filters">
              <Form.Item name="userId" label="사용자 ID" rules={[{ pattern: userIdPattern, transform: trimFilter, message: '사용자 ID 형식을 확인해주세요.' }]}><Input /></Form.Item>
              <Form.Item name="diagnosisId" label="진단 ID" rules={[{ pattern: userIdPattern, transform: trimFilter, message: '진단 ID 형식을 확인해주세요.' }]}><Input /></Form.Item>
              <Form.Item name="type" label="대표 유형"><Select allowClear options={Object.entries(badges).map(([value, label]) => ({ value, label }))} /></Form.Item>
              <Form.Item name="age" label="연령"><Select allowClear options={['19_22', '23_25', '26_29', '30_PLUS'].map((value) => ({ value, label: value === '30_PLUS' ? '30 이상' : value.replace('_', '–') }))} /></Form.Item>
              <Form.Item name="status" label="계정 상태"><Select allowClear options={Object.entries(statuses).map(([value, label]) => ({ value, label }))} /></Form.Item>
              <Form.Item name="tagId" label={operator ? '태그' : '태그 ID'} rules={[{ pattern: userIdPattern, transform: trimFilter, message: '태그 ID 형식을 확인해주세요.' }]}>
                {operator ? <Select allowClear options={tags.map((tag) => ({ value: tag.id, label: tag.name }))} /> : <Input />}
              </Form.Item>
              <Form.Item name="from" label="시작일 (KST)"><Input type="date" /></Form.Item>
              <Form.Item name="to" label="종료일 (KST)"><Input type="date" /></Form.Item>
            </div>
            <Form.Item name="includeNoDiagnosis" valuePropName="checked"><Checkbox>완료 진단 없는 사용자 포함</Checkbox></Form.Item>
            <Button htmlType="submit" type="primary" loading={loading}>조회</Button>
          </Form>
          {operator && <AdminBulkTagPanel contextKey={JSON.stringify([filters, page, currentSelection])} loading={loading}
            tags={tags} selected={currentSelection} filter={Object.fromEntries(
              Object.entries(filters).filter(([, value]) => value != null && value !== '').map(([key, value]) =>
                [key, typeof value === 'string' ? value.trim() || undefined : value]),
            )} changed={refreshUsers} />}
          <Table<User> rowSelection={operator ? {
            selectedRowKeys: currentSelection,
            onChange: (keys) => { setSelectionSearch(search); setChecked(keys.map(String)) },
            getCheckboxProps: () => ({ disabled: loading }),
          } : undefined} rowKey="id" dataSource={list?.items ?? []} loading={loading} pagination={false} scroll={{ x: 900 }} columns={[
            { title: '사용자 ID', dataIndex: 'id', render: (id: string) => <Button type="link" onClick={() => selectUser(id)}>{id}</Button> },
            { title: '이메일', dataIndex: 'maskedEmail' },
            { title: '가입일 (KST)', dataIndex: 'createdAt', render: formatDate },
            { title: '마지막 진단 (KST)', dataIndex: 'lastDiagnosisAt', render: formatDate },
            { title: '유형', dataIndex: 'representativeType', render: (value: string | null) => value ? badges[value] : '—' },
            { title: '진단 횟수', dataIndex: 'diagnosisCount' },
            { title: '상태', dataIndex: 'status', render: (value: User['status']) => statuses[value] },
            { title: '태그', dataIndex: 'tags', render: (value: string[]) => value.join(', ') || '—' },
          ]} />
          <Pagination current={page} pageSize={20} total={list?.total ?? 0} onChange={(next) => applyFilters(filters, next)} showSizeChanger={false} />
        </Space>
      )}
    </Card>
  )
}
