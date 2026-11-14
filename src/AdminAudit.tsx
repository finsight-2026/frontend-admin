import { adminFetch } from './adminFetch'
import { Alert, Button, Card, Form, Input, Pagination, Select, Space, Table, Tag } from 'antd'
import { useEffect, useState } from 'react'

type Entry = {
  id: string; actorId: string; roles: string[]; action: string; targetType: string
  targetId: string; result: string; changes: { source?: string; [key: string]: unknown }; traceId: string; createdAt: string
}
type Filters = Partial<Record<'actorId' | 'action' | 'targetId' | 'result' | 'reason' | 'from' | 'to', string>>
type Page = { items: Entry[]; total: number }

const date = new Intl.DateTimeFormat('ko-KR', {
  dateStyle: 'medium', timeStyle: 'medium', timeZone: 'Asia/Seoul',
})
const exportActions: Record<string, string> = {
  MASKED_USERS_EXPORT_DOWNLOADED: '마스킹 사용자 CSV 다운로드',
  DASHBOARD_EXPORT_DOWNLOADED: '대시보드 파일 다운로드',
  CONTENT_PERFORMANCE_EXPORT_DOWNLOADED: '콘텐츠 성과 파일 다운로드',
  PII_EXPORT_DOWNLOADED: '개인정보 원문 다운로드',
  EXPORT_DOWNLOAD_DENIED: '파일 다운로드 거부',
}
const results: Record<string, string> = { SUCCESS: '성공', FAILURE: '실패' }

export default function AdminAudit() {
  const [form] = Form.useForm<Filters>()
  const [query, setQuery] = useState({ page: 1, filters: {} as Filters })
  const [data, setData] = useState<Page>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const controller = new AbortController()
    const params = new URLSearchParams({ page: String(query.page) })
    for (const [name, value] of Object.entries(query.filters)) {
      if (value?.trim()) params.set(name, value.trim())
    }
    adminFetch('/api/v1/admin/audit-logs?' + params, { signal: controller.signal }).then(async (response) => {
      if (response.ok) return response.json() as Promise<Page>
      if (response.status === 401) throw new Error('다시 로그인해주세요.')
      if (response.status === 403) throw new Error('감사 기록을 조회할 권한이 없습니다.')
      throw new Error('감사 기록 조회 조건을 확인해주세요.')
    }).then((value) => {
      if (!controller.signal.aborted) setData(value)
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '기록을 불러오지 못했습니다.')
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false)
    })
    return () => controller.abort()
  }, [query])

  function search(next: typeof query) {
    setLoading(true)
    setError(undefined)
    setData(undefined)
    setQuery(next)
  }

  return (
    <Card title="감사 기록">
      <Space orientation="vertical" style={{ display: 'flex' }}>
        {error && <Alert title={error} type="error" />}
        <Form<Filters> form={form} layout="vertical" onFinish={(filters) => search({ filters, page: 1 })}>
          <div className="admin-user-filters">
            <Form.Item name="actorId" label="관리자 ID"><Input /></Form.Item>
            <Form.Item name="action" label="작업 코드"><Input /></Form.Item>
            <Form.Item name="targetId" label="대상 ID"><Input /></Form.Item>
            <Form.Item name="result" label="처리 결과"><Select allowClear
              options={Object.entries(results).map(([value, label]) => ({ value, label }))} /></Form.Item>
            <Form.Item name="reason" label="사유"><Input maxLength={500} /></Form.Item>
            <Form.Item name="from" label="시작일 (KST)"><Input type="date" /></Form.Item>
            <Form.Item name="to" label="종료일 (KST)"><Input type="date" /></Form.Item>
          </div>
          <Space wrap>
            <Button htmlType="submit" loading={loading}>조회</Button>
            <Button onClick={() => {
              const fields = { action: 'EXPORT_DOWNLOAD_DENIED', result: 'FAILURE' }
              form.setFieldsValue(fields)
              search({ page: 1, filters: { ...form.getFieldsValue(), ...fields } })
            }}>다운로드 거부 조회</Button>
          </Space>
        </Form>
        <Table<Entry> rowKey="id" dataSource={data?.items ?? []} pagination={false} loading={loading}
          scroll={{ x: 1000 }} expandable={{ expandedRowRender: (entry) =>
            <pre style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(entry.changes, null, 2)}</pre>,
          }} columns={[
            { title: '시각 (KST)', dataIndex: 'createdAt', render: (value: string) => date.format(new Date(value)) },
            { title: '수행 주체', render: (_, entry) => entry.changes.source === 'SERVER_CONSOLE' ? '서버 콘솔' : entry.actorId },
            { title: '작업', dataIndex: 'action', render: (value: string) => exportActions[value] ?? value },
            { title: '대상', render: (_, entry) => entry.targetType + ' · ' + entry.targetId },
            { title: '결과', dataIndex: 'result', render: (value: string) => <Tag>{results[value] ?? value}</Tag> },
            { title: '추적 ID', dataIndex: 'traceId' },
          ]} />
        <Pagination current={query.page} pageSize={20} total={data?.total ?? 0}
          onChange={(page) => search({ ...query, page })} showSizeChanger={false} />
      </Space>
    </Card>
  )
}
