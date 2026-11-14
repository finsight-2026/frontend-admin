import { adminFetch } from './adminFetch'
import { Alert, Button, Card, Form, Radio, Select, Space, Tag as StatusTag, Typography } from 'antd'
import { useEffect, useState } from 'react'
import type { Tag } from './AdminUserTags'

type Operation = { scope: 'SELECTED' | 'FILTER'; action: 'ADD_TAGS' | 'REMOVE_TAGS'; tagIds: string[] }
type Preview = { previewId: string; total: number; excluded: number; expiresAt: string }
type Job = { id: string; status: 'QUEUED' | 'COMPLETED' | 'FAILED'; total: number; excluded: number; changed: number }

const root = '/api/v1/admin/user-bulk'
const date = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short',
})
async function decode<T>(response: Response) {
  if (response.ok) return response.json() as Promise<T>
  const messages: Record<number, string> = {
    401: '다시 로그인해주세요.',
    403: '일괄 작업 권한이 없습니다.',
    404: '작업 또는 미리보기를 찾을 수 없습니다.',
    409: '미리보기가 만료되었거나 적용할 대상이 없습니다.',
    422: '대상 범위와 태그 선택을 확인해주세요.',
  }
  throw new Error(messages[response.status] ?? '일괄 태그 요청에 실패했습니다.')
}

async function post<T>(path: string, body: object) {
  const csrf = await adminFetch('/api/v1/admin/auth/csrf').then(decode<{ token: string; headerName: string }>)
  return adminFetch(root + path, {
    method: 'POST', headers: { [csrf.headerName]: csrf.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(decode<T>)
}

export default function AdminBulkTagPanel({ tags, selected, filter, contextKey, loading, changed }: {
  tags: Tag[]; selected: string[]; filter: object; contextKey: string; loading: boolean; changed: () => void
}) {
  const [storedPreview, setPreview] = useState<{ key: string; value: Preview }>()
  const preview = storedPreview?.key === contextKey ? storedPreview.value : undefined
  const [job, setJob] = useState<Job>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [form] = Form.useForm<Operation>()
  const jobId = job?.id
  const queued = job?.status === 'QUEUED'

  useEffect(() => {
    if (!jobId || !queued) return
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    async function refresh() {
      try {
        const result = await adminFetch(root + '/' + jobId, { signal: abort.signal }).then(decode<Job>)
        if (abort.signal.aborted) return
        setError(undefined)
        setJob(result)
        if (result.status === 'COMPLETED') changed()
        if (result.status === 'QUEUED') timer = setTimeout(refresh, 2000)
      } catch (failure) {
        if (abort.signal.aborted) return
        setError(failure instanceof Error ? failure.message : '작업 상태를 조회하지 못했습니다.')
        timer = setTimeout(refresh, 4000)
      }
    }
    timer = setTimeout(refresh, 1200)
    return () => { clearTimeout(timer); abort.abort() }
  }, [jobId, queued, changed])

  async function request(values: Operation) {
    if (busy || queued || loading) return
    setBusy(true)
    setError(undefined)
    setPreview(undefined)
    setJob(undefined)
    try {
      const target = values.scope === 'SELECTED' ? { userIds: selected } : { filter }
      const value = await post<Preview>('/preview', { ...target, action: values.action, tagIds: values.tagIds })
      setPreview({ key: contextKey, value })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '대상을 확인하지 못했습니다.')
    } finally {
      setBusy(false)
    }
  }

  async function confirm() {
    if (!preview || busy || loading) return
    setBusy(true)
    setError(undefined)
    try {
      setJob(await post<Job>('', { previewId: preview.previewId }))
      setPreview(undefined)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '작업을 접수하지 못했습니다.')
    } finally {
      setBusy(false)
    }
  }

  return <Card size="small" title="일괄 태그">
    <Space orientation="vertical" style={{ display: 'flex' }}>
      {error && <Alert type="error" title={error} />}
      <Form<Operation> form={form} layout="vertical" onFinish={request} disabled={busy || queued || loading}
        initialValues={{ scope: 'SELECTED', action: 'ADD_TAGS' }} onValuesChange={() => setPreview(undefined)}>
        <div className="admin-user-filters">
          <Form.Item name="scope" label="대상 범위">
            <Radio.Group options={[
              { value: 'SELECTED', label: `현재 페이지 선택 ${selected.length}명` },
              { value: 'FILTER', label: '적용한 검색 조건 전체' },
            ]} />
          </Form.Item>
          <Form.Item name="action" label="작업">
            <Select options={[{ value: 'ADD_TAGS', label: '태그 추가' }, { value: 'REMOVE_TAGS', label: '태그 제거' }]} />
          </Form.Item>
          <Form.Item name="tagIds" label="태그" rules={[{ required: true, message: '태그를 선택해주세요.' }]}>
            <Select mode="multiple" maxCount={20} options={tags.map(({ id, name }) => ({ value: id, label: name }))} />
          </Form.Item>
        </div>
        <Button htmlType="submit" loading={busy}>대상 미리보기</Button>
      </Form>
      {preview && <Space wrap>
        <Typography.Text>검색 대상 {preview.total}명 · 적용 가능 {preview.total - preview.excluded}명 · 제외 {preview.excluded}명</Typography.Text>
        <Typography.Text type="secondary">만료 {date.format(new Date(preview.expiresAt))} (KST)</Typography.Text>
        <Button type="primary" loading={busy} disabled={loading || preview.total <= preview.excluded}
          onClick={() => void confirm()}>이 대상에 적용</Button>
      </Space>}
      {job && <Space wrap>
        <StatusTag>{job.status === 'QUEUED' ? '작업 대기' : job.status === 'COMPLETED' ? '작업 완료' : '작업 실패'}</StatusTag>
        {job.status !== 'QUEUED' && <Typography.Text>변경 {job.changed}명 · 제외 {job.excluded}명</Typography.Text>}
      </Space>}
    </Space>
  </Card>
}
