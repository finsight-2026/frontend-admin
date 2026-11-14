import { useAdminUnsaved } from './adminNavigation'
import { adminFetch } from './adminFetch'
import { Alert, Button, Card, Descriptions, Form, Input, InputNumber, Popconfirm, Select, Space, Table, Tag } from 'antd'
import { useEffect, useState } from 'react'
import type { Tag as UserTag } from './AdminUserTags'

type Range = { from?: string; to?: string }
type Conditions = {
  types?: string[]; ages?: string[]; tagIds?: string[]
  minDiagnoses?: number; maxDiagnoses?: number
  lastDiagnosis?: Range; signup?: Range; activity?: Range
}
type Fields = { name: string; description?: string; conditions: Conditions }
type Segment = Fields & { id: string; status: 'ACTIVE' | 'ARCHIVED'; version: number; definitionVersion: number }
type Preview = {
  total: number; consented: number; deviceCount: number; eligible: number; localEligible: number
  excludedByReason: Record<'WITHDRAWAL_PENDING' | 'OPTED_OUT' | 'DAILY_CAP' | 'NO_DEVICE', number>
  asOf: string; definitionVersion: number
}

const root = '/api/v1/admin/segments'
const typeOptions = Object.entries({
  DEBT: '부채부담형', INCOME: '소득불안형', EMERGENCY_FUND: '비상자금취약형',
  FIXED_COST: '고정비압박형', FUTURE: '미래불안형', FAMILY: '부양부담형',
}).map(([value, label]) => ({ value, label }))
const ages = Object.entries({ '19_22': '19~22세', '23_25': '23~25세', '26_29': '26~29세', '30_PLUS': '30세 이상' })
  .map(([value, label]) => ({ value, label }))
const dates = [
  { key: 'lastDiagnosis', label: '최근 진단일' }, { key: 'signup', label: '가입일' }, { key: 'activity', label: '최근 활동일' },
] as const
const time = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short',
})

async function checked(response: Response) {
  if (response.ok) return response
  const messages: Record<number, string> = {
    401: '다시 로그인해주세요.', 403: '세그먼트를 관리할 권한이 없습니다.',
    404: '세그먼트를 찾을 수 없습니다.',
    409: '세그먼트가 변경되었거나 보관되었습니다. 목록을 갱신해주세요.',
    422: '이름과 조건의 입력 범위를 확인해주세요.',
  }
  throw new Error(messages[response.status] ?? '세그먼트 요청에 실패했습니다.')
}
async function mutate(path: string, method: string, input?: object) {
  const csrf = await adminFetch('/api/v1/admin/auth/csrf').then(checked)
    .then((response) => response.json() as Promise<{ headerName: string; token: string }>)
  return adminFetch(root + path, {
    method, headers: { [csrf.headerName]: csrf.token, 'Content-Type': 'application/json' },
    body: input == null ? undefined : JSON.stringify(input),
  }).then(checked)
}

function compactRange(value?: Range) {
  return value?.from || value?.to ? { from: value.from || undefined, to: value.to || undefined } : undefined
}

export default function AdminSegments() {
  const [rows, setRows] = useState<Segment[]>([])
  const [tags, setTags] = useState<UserTag[]>([])
  const [editing, setEditing] = useState<Segment | 'NEW'>()
  const { mark: markUnsaved } = useAdminUnsaved(editing != null)
  const [preview, setPreview] = useState<{ name: string; value: Preview }>()
  const [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    const abort = new AbortController()
    void Promise.all([
      adminFetch(root, { signal: abort.signal }).then(checked).then((response) => response.json() as Promise<Segment[]>),
      adminFetch('/api/v1/admin/tags', { signal: abort.signal }).then(checked).then((response) => response.json() as Promise<UserTag[]>),
    ]).then(([segments, tagList]) => {
      if (abort.signal.aborted) return
      setRows(segments)
      setTags(tagList)
    }).catch((failure: unknown) => {
      if (!abort.signal.aborted) setError(failure instanceof Error ? failure.message : '목록을 불러오지 못했습니다.')
    }).finally(() => {
      if (!abort.signal.aborted) setLoading(false)
    })
    return () => abort.abort()
  }, [revision])

  function refresh() {
    setLoading(true)
    setError(undefined)
    setRevision((value) => value + 1)
  }

  function open(item: Segment | 'NEW') {
    setEditing(item)
    setPreview(undefined)
    setError(undefined)
  }

  async function perform(action: () => Promise<void>) {
    setError(undefined)
    setBusy(true)
    try {
      await action()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '요청에 실패했습니다.')
    } finally {
      setBusy(false)
    }
  }

  async function save(values: Fields) {
    if (!editing) return
    const conditions = values.conditions ?? {}
    const fields = { ...values, conditions: {
      ...conditions,
      lastDiagnosis: compactRange(conditions.lastDiagnosis),
      signup: compactRange(conditions.signup),
      activity: compactRange(conditions.activity),
    } }
    await perform(async () => {
      if (editing === 'NEW') await mutate('', 'POST', fields)
      else await mutate('/' + editing.id, 'PATCH', { fields, expectedVersion: editing.version })
      setEditing(undefined)
      setPreview(undefined)
      refresh()
    })
  }

  function runPreview(item: Segment) {
    setPreview(undefined)
    void perform(async () => {
      const response = await mutate('/' + item.id + '/preview', 'POST')
      setPreview({ name: item.name, value: await response.json() as Preview })
    })
  }

  function archive(item: Segment) {
    void perform(async () => {
      await mutate('/' + item.id + '/archive', 'POST', { expectedVersion: item.version })
      setEditing(undefined)
      setPreview(undefined)
      refresh()
    })
  }

  return <Card title="CRM 세그먼트" extra={<Space>
    <Button disabled={busy} loading={loading} onClick={refresh}>목록 갱신</Button>
    <Button type="primary" disabled={busy} onClick={() => open('NEW')}>세그먼트 추가</Button>
  </Space>}>
    <Space orientation="vertical" style={{ display: 'flex' }}>
      {error && <Alert type="error" showIcon title={error} />}
      {editing && <Form<Fields> onValuesChange={markUnsaved} key={editing === 'NEW' ? 'new' : editing.id + '/' + editing.version}
        initialValues={editing === 'NEW' ? undefined : editing} layout="vertical" onFinish={save} disabled={busy}>
        <div className="admin-user-filters">
          <Form.Item name="name" label="이름" rules={[{ required: true, whitespace: true }]}>
            <Input maxLength={50} />
          </Form.Item>
          <Form.Item name="description" label="설명"><Input maxLength={300} /></Form.Item>
          <Form.Item name={['conditions', 'types']} label="대표 유형"><Select mode="multiple" options={typeOptions} /></Form.Item>
          <Form.Item name={['conditions', 'ages']} label="연령대"><Select mode="multiple" options={ages} /></Form.Item>
          <Form.Item name={['conditions', 'tagIds']} label="태그">
            <Select mode="multiple" options={tags.map(({ id, name }) => ({ value: id, label: name }))} />
          </Form.Item>
          <Form.Item name={['conditions', 'minDiagnoses']} label="최소 완료 진단 횟수"><InputNumber min={0} precision={0} /></Form.Item>
          <Form.Item name={['conditions', 'maxDiagnoses']} label="최대 완료 진단 횟수"><InputNumber min={0} precision={0} /></Form.Item>
          {dates.flatMap(({ key, label }) => (['from', 'to'] as const).map((edge) =>
            <Form.Item key={key + edge} name={['conditions', key, edge]} label={label + (edge === 'from' ? ' 시작' : ' 종료') + ' (KST)'}>
              <Input type="date" />
            </Form.Item>))}
        </div>
        <Space>
          <Button type="primary" htmlType="submit" loading={busy}>저장</Button>
          <Button onClick={() => setEditing(undefined)}>취소</Button>
        </Space>
      </Form>}
      <Table<Segment> rowKey="id" dataSource={rows} loading={loading} scroll={{ x: 650 }}
        pagination={{ pageSize: 10 }} columns={[
          { title: '이름', dataIndex: 'name' },
          { title: '설명', dataIndex: 'description' },
          { title: '조건 버전', dataIndex: 'definitionVersion' },
          { title: '상태', render: (_, item) => <Tag>{item.status === 'ACTIVE' ? '활성' : '보관'}</Tag> },
          { title: '작업', render: (_, item) => item.status === 'ACTIVE' ? <Space wrap>
            <Button disabled={busy} onClick={() => open(item)}>수정</Button>
            <Button disabled={busy} onClick={() => runPreview(item)}>대상 미리보기</Button>
            <Popconfirm title="세그먼트를 보관할까요?" onConfirm={() => archive(item)}>
              <Button disabled={busy}>보관</Button>
            </Popconfirm>
          </Space> : '—' },
        ]} />
      {preview && <Descriptions bordered size="small" title={preview.name + ' · 조건 버전 ' + preview.value.definitionVersion}
        column={{ xs: 1, md: 2 }} items={[
          { key: 'at', label: '조회 시각 (KST)', children: time.format(new Date(preview.value.asOf)) },
          { key: 'total', label: '조건 일치', children: preview.value.total },
          { key: 'consent', label: '전체 알림 동의', children: preview.value.consented },
          { key: 'device', label: '유효한 푸시 기기 보유', children: preview.value.deviceCount },
          { key: 'eligible', label: '푸시 수신 예상', children: preview.value.eligible },
          { key: 'local', label: '기기 검사 전 조건 충족', children: preview.value.localEligible },
          { key: 'withdrawal', label: '탈퇴 대기 제외', children: preview.value.excludedByReason.WITHDRAWAL_PENDING },
          { key: 'opted', label: '미동의 제외', children: preview.value.excludedByReason.OPTED_OUT },
          { key: 'cap', label: '일일 한도 제외', children: preview.value.excludedByReason.DAILY_CAP },
          { key: 'no-device', label: '유효한 푸시 기기 없음', children: preview.value.excludedByReason.NO_DEVICE },
        ]} />}
    </Space>
  </Card>
}
