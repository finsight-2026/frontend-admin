import { adminFetch } from './adminFetch'
import { Alert, Button, Card, Col, Form, Input, Progress, Row, Segmented, Space, Table, Tag, Typography } from 'antd'
import { useEffect, useState } from 'react'

type Filter = { from?: string; to?: string }
type Funnel = Required<Filter> & {
  entries: number; started: number; q1: number; q15: number; submitted: number
  results: number; guides: number; provisional: number
}
type Question = {
  number: number; text: string; reached: number; answered: number; dropped: number
  averageActiveMs: number | null; distribution: number[]
}
type Limits = { check: number; priority: number }
type Report = { funnel: Funnel; questions: Question[]; limits: Limits }
const sections = [
  { label: '전체', value: 'all', from: 1, to: 30 },
  { label: '외부압박', value: 'pressure', from: 1, to: 17 },
  { label: '대응자원', value: 'resources', from: 18, to: 26 },
  { label: '체감', value: 'perceived', from: 27, to: 29 },
  { label: '참고', value: 'other', from: 30, to: 30 },
]
const rate = (value: number, denominator: number) =>
  denominator ? (value / denominator * 100).toFixed(1) + '%' : '—'

export default function AdminDiagnosisFunnel() {
  const [filter, setFilter] = useState<Filter>({})
  const [report, setReport] = useState<Report>()
  const data = report?.funnel
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    const controller = new AbortController()
    const params = new URLSearchParams()
    if (filter.from) params.set('from', filter.from)
    if (filter.to) params.set('to', filter.to)
    adminFetch('/api/v1/admin/diagnosis-funnel?' + params, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          if (response.status === 401) {
            setReport(undefined)
            throw new Error('세션이 만료됐습니다. 다시 로그인해주세요.')
          }
          throw new Error('퍼널을 조회하지 못했습니다. 기간을 확인하고 다시 시도해주세요.')
        }
        return response.json() as Promise<Report>
      }).then((result) => {
        if (!controller.signal.aborted) setReport(result)
      }).catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '조회에 실패했습니다.')
      }).finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [filter])

  const steps = data ? [
    { label: '진단 안내 진입', count: data.entries },
    { label: 'Q1 진입', count: data.q1 },
    { label: 'Q15 응답 완료', count: data.q15 },
    { label: 'Q30 제출 완료', count: data.submitted },
    { label: '결과 조회', count: data.results },
    { label: '가이드 조회', count: data.guides },
  ].map((step, index, all) => ({
    ...step,
    previous: index === 0 ? '—' : rate(step.count, all[index - 1].count),
    cumulative: rate(step.count, data.entries),
  })) : []

  return <Card id="diagnosis-funnel" title={
    <Typography.Title level={2} className="admin-analytics-title">진단 퍼널 및 설문 문항 이탈 분석</Typography.Title>
  }>
    <Space orientation="vertical" style={{ display: 'flex' }}>
      {error && <Alert type="error" title={error} />}
      <Form<Filter> layout="vertical" onFinish={(values) => {
        setLoading(true)
        setError(undefined)
        setFilter({ ...values })
      }}>
        <div className="admin-user-filters">
          <Form.Item name="from" label="시작일 (KST)"><Input type="date" /></Form.Item>
          <Form.Item name="to" label="종료일 (KST)"><Input type="date" /></Form.Item>
        </div>
        <Button htmlType="submit" loading={loading}>조회</Button>
      </Form>
      {data && <Space wrap>
        <span>{data.from} ~ {data.to} · 시작한 시도 {data.started}건</span>
        {data.provisional > 0 && <Tag color="gold">24시간 관측 중 {data.provisional}건</Tag>}
      </Space>}
      {data && <Row gutter={[12, 12]}>
        {steps.map((step) => <Col xs={12} sm={8} xl={4} key={step.label}>
          <Card size="small">
            <Typography.Text type="secondary">{step.label}</Typography.Text>
            <div><Typography.Text strong>{step.count.toLocaleString('ko-KR')}건</Typography.Text></div>
            <Progress
              percent={data.entries ? step.count / data.entries * 100 : 0}
              showInfo={false}
              strokeColor="var(--Primary)"
              aria-hidden="true"
            />
          </Card>
        </Col>)}
      </Row>}
      <Table rowKey="label" dataSource={steps} loading={loading} pagination={false} scroll={{ x: 480 }}
        columns={[
          { title: '단계', dataIndex: 'label' },
          { title: '여정 수', dataIndex: 'count', align: 'right' },
          { title: '직전 전환율', dataIndex: 'previous', align: 'right' },
          { title: '누적 전환율', dataIndex: 'cumulative', align: 'right' },
        ]} />
      {report && <QuestionTable questions={report.questions} limits={report.limits} />}
    </Space>
  </Card>
}

function QuestionTable({ questions, limits }: { questions: Question[]; limits: Limits }) {
  const [section, setSection] = useState('all')
  const range = sections.find(({ value }) => value === section) ?? sections[0]
  const rows = questions.filter(({ number }) => number >= range.from && number <= range.to)
  const maximum = rows.filter(({ reached }) => reached > 0).sort((a, b) =>
    b.dropped * a.reached - a.dropped * b.reached || b.reached - a.reached || a.number - b.number
  )[0]
  return <>
    <Typography.Title level={3}>문항별 도달·이탈 분석</Typography.Title>
    <Segmented value={section} onChange={setSection} options={sections.map(({ label, value }) => ({ label, value }))} />
    {maximum && maximum.dropped > 0 && <Typography.Text>최대 이탈 Q{maximum.number} · {rate(maximum.dropped, maximum.reached)}</Typography.Text>}
    <Table<Question> rowKey="number" dataSource={rows} scroll={{ x: 920 }}
      pagination={{ pageSize: 10, showSizeChanger: false }}
      expandable={{ expandedRowRender: (row) =>
        <Space wrap aria-label="완료 진단의 역채점 전 응답 분포">
          {row.distribution.map((count, index) => <Tag key={index}>{index + 1}점 · {count}건</Tag>)}
        </Space>,
      }}
      columns={[
        { title: '문항', width: 360, render: (_, row) => `Q${row.number} ${row.text}` },
        { title: '도달', dataIndex: 'reached', align: 'right' },
        { title: '응답 완료', dataIndex: 'answered', align: 'right' },
        { title: '이탈', dataIndex: 'dropped', align: 'right' },
        { title: '이탈률', render: (_, row) => rate(row.dropped, row.reached), align: 'right' },
        { title: '평균 활동시간', render: (_, row) => row.averageActiveMs == null ? '—' : `${(row.averageActiveMs / 1000).toFixed(1)}초` },
        { title: '점검', render: (_, row) => {
          if (row.reached < 30) return <Tag>표본 부족</Tag>
          const drop = row.dropped / row.reached * 100
          if (drop >= limits.priority) return <Tag color="red">우선 점검</Tag>
          return drop > limits.check ? <Tag color="gold">점검</Tag> : '—'
        } },
      ]} />
  </>
}
