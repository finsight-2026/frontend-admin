import { adminFetch } from './adminFetch'
import { Alert, Button, Card, Descriptions, Form, Grid, Input, Pagination, Select, Space, Table, Tag } from 'antd'
import { useEffect, useState } from 'react'

type Filters = Partial<Record<'eventId' | 'userId' | 'attemptId' | 'journeyId' | 'type' | 'from' | 'to', string>>
type Event = {
  eventId: string; eventName: string; userId: string; attemptId?: string; journeyId?: string
  diagnosisId?: string; contentId?: string; notificationId?: string; occurredAt: string; receivedAt: string; clockAdjusted: boolean
  contentKind?: string; contentRevision?: number; placement?: string
  experimentId?: string; screenId?: string; variantId?: string
  properties: { questionNo?: number; activeMs?: number; activityDate?: string; month?: string; value?: boolean }
}
type Page = { items: Event[]; total: number }
const labels: Record<string, string> = {
  USER_SIGNED_UP: '회원가입 완료', PROFILE_CONSENT_COMPLETED: '필수 프로필·동의 완료',
  APP_FOREGROUND: '앱 포그라운드 진입', DIAGNOSIS_ENTRY_VIEWED: '진단 안내 진입',
  SURVEY_STARTED: '설문 시작', QUESTION_VIEWED: '문항 도달', QUESTION_COMPLETED: '문항 응답 완료',
  SURVEY_ABORTED: '설문 중단', SURVEY_COMPLETED: '설문 제출 완료', RESULT_VIEWED: '결과 열람',
  GUIDE_VIEWED: '가이드 열람', GUIDE_COMPLETION_SET: '가이드 실천 변경', NOTIFICATION_OPENED: '앱 알림함에서 열기',
  CONTENT_IMPRESSION: '콘텐츠 카드 노출', CONTENT_VIEWED: '콘텐츠 상세 열람',
  HELPFUL_SET: '인사이트 도움 반응 변경',
  EXPERIMENT_EXPOSED: '실험안 최초 노출',
  USER_DELETION_REQUESTED: '서비스 데이터 삭제 신청',
  USER_WITHDRAWAL_REQUESTED: '회원탈퇴 신청',
}
const idFields = [
  ['eventId', '이벤트 ID'], ['userId', '사용자 ID'], ['attemptId', '진단 시도 ID'], ['journeyId', '진단 여정 ID'],
] as const
const time = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'Asia/Seoul' })

export default function AdminEvents() {
  const [form] = Form.useForm<Filters>()
  const { lg } = Grid.useBreakpoint()
  const [query, setQuery] = useState({ page: 1, filters: {} as Filters })
  const [data, setData] = useState<Page>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const abort = new AbortController()
    const params = new URLSearchParams({ page: String(query.page) })
    for (const [key, value] of Object.entries(query.filters)) if (value?.trim()) params.set(key, value.trim())
    void adminFetch('/api/v1/admin/events?' + params, { cache: 'no-store', signal: abort.signal }).then(async (response) => {
      if (response.ok) return response.json() as Promise<Page>
      if (response.status === 401) throw new Error('다시 로그인해주세요.')
      if (response.status === 403) throw new Error('이벤트 조회 권한이 없습니다.')
      throw new Error('이벤트를 불러오지 못했습니다. 조회 조건을 확인해주세요.')
    }).then((page) => {
      if (!abort.signal.aborted) setData(page)
    }).catch((failure: unknown) => {
      if (!abort.signal.aborted) setError(failure instanceof Error ? failure.message : '이벤트를 불러오지 못했습니다.')
    }).finally(() => {
      if (!abort.signal.aborted) setLoading(false)
    })
    return () => abort.abort()
  }, [query])

  function search(next: typeof query) {
    setLoading(true)
    setError(undefined)
    setData(undefined)
    setQuery(next)
  }

  return <Card title="앱 이벤트">
    <Space orientation="vertical" style={{ display: 'flex' }}>
      {error && <Alert type="error" title={error} showIcon
        action={<Button size="small" onClick={() => search({ ...query })}>다시 조회</Button>} />}
      <Form<Filters> form={form} layout="vertical" scrollToFirstError={{ focus: true }}
        onFinish={(filters) => search({ page: 1, filters })}>
        <div className="admin-user-filters">
          {idFields.map(([key, label]) => <Form.Item key={key} name={key} label={label} rules={[{
            pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, message: 'UUID 형식을 확인해주세요.',
          }]}><Input allowClear /></Form.Item>)}
          <Form.Item name="type" label="이벤트 종류">
            <Select allowClear options={Object.entries(labels).map(([value, label]) => ({ value, label }))} />
          </Form.Item>
          <Form.Item name="from" label="시작일 (KST)"><Input type="date" /></Form.Item>
          <Form.Item name="to" label="종료일 (KST)"><Input type="date" /></Form.Item>
        </div>
        <Space>
          <Button type="primary" htmlType="submit" loading={loading}>조회</Button>
          <Button onClick={() => { form.resetFields(); search({ page: 1, filters: {} }) }}>초기화</Button>
        </Space>
      </Form>
      <Table<Event> rowKey="eventId" dataSource={data?.items ?? []} pagination={false} loading={loading}
        locale={{ emptyText: loading || error ? null : '조건에 맞는 항목이 없어요.' }}
        scroll={lg ? { x: 950 } : undefined} tableLayout={lg ? undefined : 'fixed'} columns={[
          { title: '발생 시각 (KST)', render: (_, row) => time.format(new Date(row.occurredAt)) },
          { title: '종류', render: (_, row) => <span style={{ wordBreak: 'keep-all', overflowWrap: 'anywhere' }}>
            {labels[row.eventName] ?? row.eventName}
          </span> },
          { title: '사용자 ID', dataIndex: 'userId', responsive: ['lg'] },
          { title: '이벤트 ID', dataIndex: 'eventId', responsive: ['lg'] },
          { title: '시각 보정', responsive: ['lg'], render: (_, row) => row.clockAdjusted ? <Tag color="gold">서버 시각 사용</Tag> : '—' },
        ]} expandable={{ columnWidth: 40, expandedRowRender: (row) => {
          const p = row.properties
          return <Descriptions size="small" bordered style={{ overflowWrap: 'anywhere' }} column={{ xs: 1, md: 2 }} items={[
            { key: 'received', label: '수신 시각 (KST)', children: time.format(new Date(row.receivedAt)) },
            ...(!lg ? [
              { key: 'userId', label: '사용자 ID', children: row.userId },
              { key: 'eventId', label: '이벤트 ID', children: row.eventId },
              ...(row.clockAdjusted ? [{ key: 'clock', label: '시각 보정', children: '서버 시각 사용' }] : []),
            ] : []),
            ...(row.attemptId ? [{ key: 'attempt', label: '진단 시도 ID', children: row.attemptId }] : []),
            ...(row.journeyId ? [{ key: 'journey', label: '진단 여정 ID', children: row.journeyId }] : []),
            ...(row.diagnosisId ? [{ key: 'diagnosis', label: '진단 결과 ID', children: row.diagnosisId }] : []),
            ...(row.contentId ? [{ key: 'content', label: '콘텐츠 ID', children: row.contentId }] : []),
            ...(row.contentRevision != null ? [{ key: 'revision', label: '콘텐츠 버전', children: row.contentRevision }] : []),
            ...(row.placement ? [{ key: 'placement', label: '노출 위치', children: row.placement }] : []),
            ...(row.experimentId ? [{ key: 'experiment', label: '실험 ID', children: row.experimentId }] : []),
            ...(row.screenId ? [{ key: 'screen', label: '화면 ID', children: row.screenId }] : []),
            ...(row.variantId ? [{ key: 'variant', label: '표시안 ID', children: row.variantId }] : []),
            ...(row.notificationId ? [{ key: 'notice', label: '알림 ID', children: row.notificationId }] : []),
            ...(p.questionNo != null ? [{ key: 'question', label: '문항 번호', children: p.questionNo }] : []),
            ...(p.activeMs != null ? [{ key: 'activity', label: '활동 시간', children: p.activeMs + 'ms' }] : []),
            ...(p.activityDate ? [{ key: 'date', label: '활동일 (KST)', children: p.activityDate }] : []),
            ...(p.month ? [{ key: 'month', label: '실천 월 (KST)', children: p.month.slice(0, 7) }] : []),
            ...(p.value != null ? [{
              key: 'value', label: row.eventName === 'HELPFUL_SET' ? '도움 반응' : '실천 상태',
              children: row.eventName === 'HELPFUL_SET' ? (p.value ? '설정' : '해제') : (p.value ? '완료' : '미완료'),
            }] : []),
          ]} />
        } }} />
      <Pagination current={query.page} pageSize={20} total={data?.total ?? 0}
        onChange={(page) => search({ ...query, page })} showSizeChanger={false} />
    </Space>
  </Card>
}
