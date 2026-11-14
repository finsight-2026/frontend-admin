import { adminFetch } from './adminFetch'
import { exportWrite } from './adminExportApi'
import { Alert, Button, Card, Descriptions, Form, Input, InputNumber, Modal, Select, Space, Switch, Table, Tag, Typography } from 'antd'
import { useEffect, useRef, useState } from 'react'

type Filter = { from?: string; to?: string; kind?: string; type?: string; contentId?: string; revision?: number; combineVersions?: boolean }
type Row = {
  kind: 'NEWS' | 'GUIDE' | 'INSIGHT'; contentId: string; revision: number | null; title: string; impressions: number; views: number
  ctrNumerator: number; ctr: number | null; helpful: number | null; completions: number | null
}
type Report = { from: string; to: string; completionMonth: string; asOf: string; observedAt: string; provisional: boolean; items: Row[] }
const kinds: Record<Row['kind'], string> = { NEWS: '경제 뉴스', GUIDE: '맞춤 가이드', INSIGHT: '행동 인사이트' }
const editorialLabels: Record<Row['kind'], string> = { NEWS: '뉴스', GUIDE: '가이드', INSIGHT: '인사이트' }
const types = { DEBT: '부채부담형', INCOME: '소득불안형', EMERGENCY_FUND: '비상자금취약형', FIXED_COST: '고정비압박형', FUTURE: '미래불안형', FAMILY: '부양부담형' }
const options = (values: Record<string, string>) => Object.entries(values).map(([value, label]) => ({ value, label }))
const time = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Seoul' })
const metric = (value: number | null) => value ?? '—'
const ctr = (value: number | null) => value == null ? '—' : value.toFixed(2) + '%'

export default function AdminContentPerformance({ openEditorial, openJobs }: {
  openEditorial?: (kind: Row['kind'], id: string, revision: number | null) => void
  openJobs?: (id: string) => void
}) {
  const [form] = Form.useForm<Filter>()
  const [filters, setFilters] = useState<Filter>({})
  const [data, setData] = useState<Report>()
  const [selected, setSelected] = useState<Row>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [exportJob, setExportJob] = useState<string>()
  const [exportError, setExportError] = useState<string>()
  const lastRequest = useRef<{ fingerprint: string; key: string }>(undefined)
  const combine = Form.useWatch('combineVersions', form)

  useEffect(() => {
    const abort = new AbortController()
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(filters)) if (value != null && value !== '') params.set(key, String(value))
    void adminFetch('/api/v1/admin/analytics/content-performance?' + params, { signal: abort.signal, cache: 'no-store' })
      .then(async (response) => {
        if (response.ok) return response.json() as Promise<Report>
        if (response.status === 401) throw new Error('다시 로그인해주세요.')
        if (response.status === 403) throw new Error('콘텐츠 성과를 조회할 권한이 없습니다.')
        throw new Error('조회 조건을 확인해주세요.')
      }).then((report) => {
        if (!abort.signal.aborted) setData(report)
      }).catch((failure: Error) => {
        if (!abort.signal.aborted) setError(failure.message)
      }).finally(() => {
        if (!abort.signal.aborted) setLoading(false)
      })
    return () => abort.abort()
  }, [filters])

  function search(values: Filter) {
    setError(undefined)
    setLoading(true)
    setFilters({ ...values, contentId: values.contentId?.trim(), revision: values.combineVersions ? undefined : values.revision })
  }

  async function requestExport(format: 'CSV' | 'PDF') {
    if (!data || loading || error || exporting) return
    const input = { kind: 'CONTENT_PERFORMANCE', format, filter: {
      ...filters, contentId: filters.contentId || undefined, from: data.from, to: data.to,
    } }
    const fingerprint = JSON.stringify(input)
    if (lastRequest.current?.fingerprint !== fingerprint) {
      lastRequest.current = { fingerprint, key: crypto.randomUUID() }
    }
    setExporting(true)
    setExportError(undefined)
    setExportJob(undefined)
    try {
      const job = await exportWrite<{ id: string }>('/exports', input, lastRequest.current.key)
      lastRequest.current = undefined
      setExportJob(job.id)
    } catch (failure) {
      setExportError(failure instanceof Error ? failure.message : '내보내기 요청에 실패했어요.')
    } finally {
      setExporting(false)
    }
  }

  return <Card title="콘텐츠 성과">
    <Space orientation="vertical" style={{ display: 'flex' }}>
      {error && <Alert type="error" title={error} />}
      <Form<Filter> form={form} layout="vertical" onFinish={search}>
        <div className="admin-user-filters">
          <Form.Item name="from" label="시작일 (KST)"><Input type="date" /></Form.Item>
          <Form.Item name="to" label="종료일 (KST)"><Input type="date" /></Form.Item>
          <Form.Item name="kind" label="콘텐츠 종류"><Select allowClear options={options(kinds)} /></Form.Item>
          <Form.Item name="type" label="대표 유형"><Select allowClear options={options(types)} /></Form.Item>
          <Form.Item name="contentId" label="콘텐츠 ID"><Input allowClear maxLength={80} /></Form.Item>
          <Form.Item name="revision" label="버전"><InputNumber min={1} precision={0} disabled={combine === true} /></Form.Item>
          <Form.Item name="combineVersions" label="버전 합산" valuePropName="checked"><Switch /></Form.Item>
        </div>
        <Button type="primary" htmlType="submit" loading={loading}>조회</Button>
      </Form>
      {openJobs && <Space wrap>
        <Button disabled={!data || loading || !!error} loading={exporting} onClick={() => void requestExport('CSV')}>CSV 내보내기</Button>
        <Button disabled={!data || loading || !!error} loading={exporting} onClick={() => void requestExport('PDF')}>PDF 내보내기</Button>
      </Space>}
      {exportError && <Alert type="error" title={exportError} />}
      {exportJob && <Alert type="success" title="성과 파일 요청을 접수했어요."
        description={<><Button type="link" onClick={() => openJobs?.(exportJob)}>작업 모니터</Button>
          <Typography.Text copyable>{exportJob}</Typography.Text></>} />}
      {data && <Space wrap>
        <Typography.Text>{data.from} ~ {data.to} (KST)</Typography.Text>
        <Typography.Text>실천 완료 {data.completionMonth.slice(0, 7)} 현재 상태</Typography.Text>
        <Typography.Text type="secondary">집계 기준 {time.format(new Date(data.asOf))}</Typography.Text>
        {data.provisional && <Tag color="gold">잠정 집계 · 계측 시작 {time.format(new Date(data.observedAt))}</Tag>}
      </Space>}
      <Typography.Text type="secondary">노출과 조회는 고유 사용자 수입니다. 조회율은 같은 기간에 노출과 상세 조회가 모두 발생한 사용자를 노출 사용자로 나눕니다.</Typography.Text>
      <Table<Row> rowKey={(row) => row.kind + '/' + row.contentId + '/' + row.revision}
        dataSource={data?.items ?? []} loading={loading} scroll={{ x: 880 }}
        pagination={{ pageSize: 20, showSizeChanger: false }} columns={[
          { title: '콘텐츠', render: (_, row) => <Button type="link" onClick={() => setSelected(row)}>{row.title}</Button> },
          { title: '종류', render: (_, row) => kinds[row.kind] },
          { title: '버전', render: (_, row) => row.revision ?? '합산' },
          { title: '노출', dataIndex: 'impressions', align: 'right' },
          { title: '상세 조회', dataIndex: 'views', align: 'right' },
          { title: '조회율', render: (_, row) => ctr(row.ctr), align: 'right' },
          { title: '도움 반응', render: (_, row) => metric(row.helpful), align: 'right' },
          { title: '실천 완료', render: (_, row) => metric(row.completions), align: 'right' },
        ]} />
    </Space>
    <Modal open={!!selected} title={selected?.title} onCancel={() => setSelected(undefined)} footer={null}>
      {selected && <Space orientation="vertical" style={{ display: 'flex' }}>
        <Descriptions bordered size="small" column={1} items={[
          { key: 'id', label: '콘텐츠 ID', children: <Typography.Text copyable>{selected.contentId}</Typography.Text> },
          { key: 'revision', label: '버전', children: selected.revision ?? '합산' },
          { key: 'impression', label: '노출 사용자', children: selected.impressions },
          { key: 'views', label: '상세 조회 사용자', children: selected.views },
          { key: 'ctr', label: '조회율', children: ctr(selected.ctr) + ' (' + selected.ctrNumerator + ' / ' + selected.impressions + ')' },
          { key: 'helpful', label: '도움 반응', children: metric(selected.helpful) },
          { key: 'completion', label: '실천 완료', children: metric(selected.completions) },
        ]} />
        {openEditorial && <Button type="primary" onClick={() => {
          openEditorial(selected.kind, selected.contentId, selected.revision)
          setSelected(undefined)
        }}>{editorialLabels[selected.kind]} 운영에서 열기</Button>}
      </Space>}
    </Modal>
  </Card>
}
