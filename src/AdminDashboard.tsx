import { adminFetch } from './adminFetch'
import { Alert, Button, Card, Col, Form, Input, Progress, Row, Select, Space, Statistic, Table, Tag, Typography } from 'antd'
import { QueryClient, QueryClientProvider, keepPreviousData, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { exportWrite } from './adminExportApi'

type Filters = { from?: string; to?: string; age?: string; type?: string }
type Daily = { date: string; registrations: number; attempts: number; completedWithin24Hours: number }
type CohortCell = { week: string; offset: number; registrations: number; active: number | null }
type SignupFunnel = {
  signups: number; profiles: number; started: number; completed: number; results: number
  guides: number; provisional: number
}
type Dashboard = {
  from: string; to: string; syncedAt: string
  totals: {
    registrations: number; accounts: number; attempts: number; completedWithin24Hours: number
    provisionalAttempts: number; diagnosedUsers: number; meanYfsi: number | null; meanPerceivedStress: number | null
    meanPressure: number | null; meanResources: number | null
  }
  activity: {
    observedFrom: string | null; periodActive: number | null; dau: number | null
    mau: number | null; d7Eligible: number; d7Returned: number
  }
  cohorts: CohortCell[]
  signupFunnel: SignupFunnel
  responseTime: { measuredAttempts: number; averageActiveMs: number | null }
  guideRate: { resultUsers: number; guideUsers: number }
  daily: Daily[]
  scoreDistribution: { lower: number; count: number }[]
  typeDistribution: { type: string; count: number }[]
}

const pressureNames: Record<string, string> = {
  DEBT: '부채부담형', INCOME: '소득불안형', EMERGENCY_FUND: '비상자금취약형',
  FIXED_COST: '고정비압박형', FUTURE: '미래불안형', FAMILY: '부양부담형',
}
const syncFormat = new Intl.DateTimeFormat('ko-KR', {
  dateStyle: 'medium', timeStyle: 'medium', timeZone: 'Asia/Seoul',
})
const numberFormat = new Intl.NumberFormat('ko-KR')
const percent = (count: number, denominator: number) =>
  denominator ? (count / denominator * 100).toFixed(1) + '%' : '—'

export default function AdminDashboard({ analyst, navigate }: { analyst: boolean; navigate: (path: string) => void }) {
  const [client] = useState(() => new QueryClient())
  return <QueryClientProvider client={client}><DashboardContent analyst={analyst} navigate={navigate} /></QueryClientProvider>
}

function DashboardContent({ analyst, navigate }: { analyst: boolean; navigate: (path: string) => void }) {
  const [filters, setFilters] = useState<Filters>({})
  const [exportBusy, setExportBusy] = useState(false)
  const [exportError, setExportError] = useState<string>()
  const [exportJob, setExportJob] = useState<string>()
  const [lastSuccessful, setLastSuccessful] = useState<Dashboard>()
  const summary = useQuery({
    queryKey: ['dashboard', filters],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams()
      for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value)
      const response = await adminFetch('/api/v1/admin/dashboard?' + params, { signal })
      if (!response.ok) {
        if (response.status === 401) throw new Error('세션이 만료됐습니다. 다시 로그인해주세요.')
        if (response.status === 422) throw new Error('시작일과 종료일을 확인해주세요.')
        throw new Error('집계 갱신에 실패했습니다.')
      }
      const data = await response.json() as Dashboard
      if (!signal.aborted) setLastSuccessful(data)
      return data
    },
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    retry: false,
  })
  const sessionExpired = summary.error?.message.startsWith('세션이 만료') ?? false
  const data = sessionExpired ? undefined : summary.data ?? lastSuccessful
  const totals = data?.totals

  async function requestExport(format: 'CSV' | 'PDF') {
    if (!data || summary.isPlaceholderData || summary.error) return
    setExportBusy(true)
    setExportJob(undefined)
    setExportError(undefined)
    try {
      const job = await exportWrite<{ id: string }>('/exports', {
        kind: 'DASHBOARD_AGGREGATE', format, filter: { ...filters, from: data.from, to: data.to },
      })
      setExportJob(job.id)
    } catch (failure) {
      setExportError(failure instanceof Error ? failure.message : '내보내기 요청이 실패했습니다.')
    } finally {
      setExportBusy(false)
    }
  }

  return (
    <Card title="대시보드" extra={<Button onClick={() => void summary.refetch()} loading={summary.isFetching}>새로고침</Button>}>
      <Space orientation="vertical" size="middle" style={{ display: 'flex' }}>
        <Button type="link" onClick={() => navigate('/admin/funnel')}>진단 여정 퍼널 보기</Button>
        <Form<Filters> layout="vertical" onFinish={setFilters}>
          <div className="admin-user-filters">
            <Form.Item name="from" label="시작일 (KST)"><Input type="date" /></Form.Item>
            <Form.Item name="to" label="종료일 (KST)"><Input type="date" /></Form.Item>
            <Form.Item name="age" label="연령대"><Select allowClear options={[
              { value: '19_22', label: '만 19~22세' }, { value: '23_25', label: '만 23~25세' },
              { value: '26_29', label: '만 26~29세' }, { value: '30_PLUS', label: '만 30세 이상' },
            ]} /></Form.Item>
            <Form.Item name="type" label="대표 유형"><Select allowClear options={Object.entries(pressureNames)
              .map(([value, label]) => ({ value, label }))} /></Form.Item>
          </div>
          <Button type="primary" htmlType="submit">필터 적용</Button>
        </Form>
        {summary.error && <Alert type="error" showIcon title={summary.error.message}
          description={data ? '아래에는 마지막으로 성공한 집계가 표시됩니다.' : undefined} />}
        {summary.isPending && <Typography.Text role="status">집계를 불러오는 중입니다.</Typography.Text>}
        {analyst && <Space wrap>
          <Button disabled={!data || summary.isPlaceholderData || !!summary.error} loading={exportBusy}
            onClick={() => void requestExport('CSV')}>CSV 내보내기</Button>
          <Button disabled={!data || summary.isPlaceholderData || !!summary.error} loading={exportBusy}
            onClick={() => void requestExport('PDF')}>PDF 내보내기</Button>
        </Space>}
        {exportError && <Alert type="error" title={exportError} showIcon />}
        {exportJob && <Alert type="success" showIcon title="집계 파일 요청을 접수했습니다"
          description={<><Button type="link" onClick={() => navigate('/admin/jobs')}>작업 모니터</Button> · {exportJob}</>} />}
        {data && totals && <>
          <Space wrap>
            <Typography.Text>{data.from} ~ {data.to} (KST)</Typography.Text>
            <Typography.Text type="secondary">동기화 {syncFormat.format(new Date(data.syncedAt))}</Typography.Text>
            {totals.provisionalAttempts > 0
              ? <Tag color="gold">완료율 잠정 · 관측 중 {totals.provisionalAttempts}건</Tag>
              : <Tag>완료율 관측 종료</Tag>}
          </Space>
          <Row gutter={[12, 12]}>
            {[
              ['신규 가입', totals.registrations], ['전체 가입 계정', totals.accounts],
              ['진단 시작', totals.attempts], ['24시간 내 진단 완료', totals.completedWithin24Hours],
              ['진단 완료율', percent(totals.completedWithin24Hours, totals.attempts)],
              ['완료 진단 평균 활동시간', data.responseTime.averageActiveMs == null
                ? '—' : `${(data.responseTime.averageActiveMs / 1000).toFixed(1)}초`],
              ['진단 사용자', totals.diagnosedUsers],
              ['가이드 열람률', percent(data.guideRate.guideUsers, data.guideRate.resultUsers)],
              ['기간 내 활성 사용자', data.activity.periodActive ?? '—'],
              ['종료일 DAU', data.activity.dau ?? '—'],
              ['종료일 기준 MAU', data.activity.mau ?? '—'],
              ['가입 7일 재방문율', percent(data.activity.d7Returned, data.activity.d7Eligible)],
              ['외부 압박 종합 (Q1~17)', totals.meanPressure ?? '—'],
              ['대응자원 종합 (Q18~26)', totals.meanResources ?? '—'],
              ['YFSI 평균', totals.meanYfsi ?? '—'], ['체감 스트레스 평균 (Q27~29)', totals.meanPerceivedStress ?? '—'],
            ].map(([title, value]) => (
              <Col xs={24} sm={12} xl={6} key={title}><Card size="small"><Statistic title={title} value={value} /></Card></Col>
            ))}
          </Row>
          <Typography.Text type="secondary">
            완료율은 기간 내 시작한 시도 기준입니다. 활동시간은 30문항 계측이 있는 완료 시도 {data.responseTime.measuredAttempts}건을 사용합니다.
            점수와 유형은 기간 내 사용자별 마지막 완료 1건을 사용합니다.
          </Typography.Text>
          <Typography.Text type="secondary">
            결과 열람 사용자 {data.guideRate.resultUsers}명 중 같은 진단의 가이드를 나중에 연 사용자 {data.guideRate.guideUsers}명입니다.
            이 지표는 진단 시도가 아닌 고유 사용자를 기준으로 합니다.
          </Typography.Text>
          <Typography.Text type="secondary">
            {data.activity.observedFrom
              ? `활동 관측 시작일 ${data.activity.observedFrom} (KST). 가입 7일 뒤 관측 가능 ${data.activity.d7Eligible}명 중 ${data.activity.d7Returned}명이 재방문했습니다.`
              : '인증된 앱 포그라운드 활동을 아직 관측하지 못했습니다.'}
          </Typography.Text>
          <Row gutter={[12, 12]}>
            <Col xs={24} lg={12}><Card size="small" title="YFSI 점수 분포">
              {data.scoreDistribution.map(({ lower, count }) => (
                <DistributionBar key={lower} label={lower === 90 ? '90~100점' : `${lower}점 이상~${lower + 10}점 미만`}
                  count={count} total={totals.diagnosedUsers} />
              ))}
            </Card></Col>
            <Col xs={24} lg={12}><Card size="small" title="대표 유형 분포">
              {data.typeDistribution.map(({ type, count }) => (
                <DistributionBar key={type} label={pressureNames[type]} count={count} total={totals.diagnosedUsers} />
              ))}
            </Card></Col>
          </Row>
          <Card size="small" title="가입 및 진단 일별 추이"><DailyChart days={data.daily} /></Card>
          <SignupFunnelTable funnel={data.signupFunnel} />
          <CohortTable cells={data.cohorts} />
          <Table<Daily> title={() => '일별 수치'} rowKey="date" dataSource={data.daily} scroll={{ x: 460 }}
            pagination={{ defaultPageSize: 10, showSizeChanger: false }} columns={[
              { title: '일자 (KST)', dataIndex: 'date' },
              { title: '가입', dataIndex: 'registrations', align: 'right' },
              { title: '진단 시작', dataIndex: 'attempts', align: 'right' },
              { title: '24시간 내 완료', dataIndex: 'completedWithin24Hours', align: 'right' },
            ]} />
        </>}
      </Space>
    </Card>
  )
}

function SignupFunnelTable({ funnel }: { funnel: SignupFunnel }) {
  const stages = [
    { name: '가입', count: funnel.signups },
    { name: '추가정보·필수 동의 완료', count: funnel.profiles },
    { name: '진단 시작', count: funnel.started },
    { name: '진단 완료', count: funnel.completed },
    { name: '결과 조회', count: funnel.results },
    { name: '가이드 조회', count: funnel.guides },
  ]
  return <Card size="small" title="신규가입 퍼널 · 고유 사용자">
    <Space orientation="vertical" style={{ display: 'flex' }}>
      <Typography.Text type="secondary">가입 이후 7일 이내의 순차 전환을 집계합니다.</Typography.Text>
      {funnel.provisional > 0 && <Tag color="gold">잠정 · 7일 관측 중 {funnel.provisional}명</Tag>}
      <Table rowKey="name" dataSource={stages.map((stage, index) => ({
        ...stage, previous: index ? percent(stage.count, stages[index - 1].count) : '—',
        cumulative: percent(stage.count, funnel.signups),
      }))} pagination={false} scroll={{ x: 520 }} columns={[
        { title: '단계', dataIndex: 'name' },
        { title: '고유 사용자', dataIndex: 'count', align: 'right' },
        { title: '직전 전환율', dataIndex: 'previous', align: 'right' },
        { title: '누적 전환율', dataIndex: 'cumulative', align: 'right' },
      ]} />
    </Space>
  </Card>
}

function CohortTable({ cells }: { cells: CohortCell[] }) {
  const cohorts = new Map<string, CohortCell[]>()
  for (const cell of cells) {
    const week = cohorts.get(cell.week) ?? []
    week.push(cell)
    cohorts.set(cell.week, week)
  }
  return <Table
    title={() => '주간 가입 코호트 · 활성 사용자 비율'}
    rowKey="week"
    dataSource={Array.from(cohorts, ([week, values]) => ({
      week, registrations: values[0].registrations, weeks: values,
    }))}
    scroll={{ x: 860 }}
    pagination={{ defaultPageSize: 8, showSizeChanger: false }}
    columns={[
      { title: '가입 주 시작 (월요일)', dataIndex: 'week', width: 156 },
      { title: '가입자', dataIndex: 'registrations', align: 'right', width: 76 },
      ...Array.from({ length: 8 }, (_, offset) => ({
        title: `W${offset}`, key: `week-${offset}`, align: 'right' as const,
        render: (_: unknown, row: { registrations: number; weeks: CohortCell[] }) => {
          const active = row.weeks.find((cell) => cell.offset === offset)?.active
          return active == null ? '—' : percent(active, row.registrations)
        },
      })),
    ]}
  />
}

function DailyChart({ days }: { days: Daily[] }) {
  if (!days.length) return <Typography.Text>—</Typography.Text>
  const series = [
    { key: 'registrations', label: '가입', color: '#C8FF00' },
    { key: 'attempts', label: '진단 시작', color: '#76C8FF' },
    { key: 'completedWithin24Hours', label: '24시간 내 완료', color: '#FFBA81' },
  ] as const
  const peak = Math.max(1, ...days.flatMap((day) => series.map(({ key }) => day[key])))
  const x = (index: number) => days.length === 1 ? 290 : 42 + index * 538 / (days.length - 1)
  const y = (value: number) => 115 - value * 95 / peak
  return <>
    <svg role="img" aria-label="가입, 진단 시작 및 24시간 내 완료의 일별 추이. 아래 표에서 개별 수치를 볼 수 있습니다."
      viewBox="0 0 610 145" width="100%" style={{ maxHeight: 220 }}>
      {[0, peak].map((value) => <g key={value}>
        <line x1="42" y1={y(value)} x2="580" y2={y(value)} stroke="currentColor" opacity=".25" />
        <text x="38" y={y(value) + 4} textAnchor="end" fill="currentColor" fontSize="11">{value}</text>
      </g>)}
      {series.map(({ key, color }) => days.length === 1
        ? <circle key={key} cx={x(0)} cy={y(days[0][key])} r="3" fill={color} />
        : <polyline key={key} fill="none" stroke={color} strokeWidth="2"
          points={days.map((day, index) => `${x(index)},${y(day[key])}`).join(' ')} />)}
      <text x="42" y="138" fill="currentColor" fontSize="11">{days[0].date}</text>
      {days.length > 1 && <text x="580" y="138" textAnchor="end" fill="currentColor" fontSize="11">{days.at(-1)?.date}</text>}
    </svg>
    <Space wrap>{series.map(({ key, label, color }) => <Typography.Text key={key} style={{ color }}>{label}</Typography.Text>)}</Space>
  </>
}

function DistributionBar({ label, count, total }: { label: string; count: number; total: number }) {
  return <div>
    <Typography.Text>{label} · {numberFormat.format(count)}명 · {percent(count, total)}</Typography.Text>
    <Progress showInfo={false} percent={total ? count / total * 100 : 0} />
  </div>
}
