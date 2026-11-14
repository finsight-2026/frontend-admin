import { useAdminUnsaved } from './adminNavigation'
import { adminFetch } from './adminFetch'
import { Alert, Button, Card, Form, Input, Select, Space } from 'antd'
import { useEffect, useState } from 'react'

export type Tag = { id: string; name: string; version: number }
type Selection = { tagIds: string[] }
type TagForm = { tagId?: string; name: string }

async function decode<T>(response: Response): Promise<T> {
  if (response.ok) return response.json() as Promise<T>
  const messages: Record<number, string> = {
    401: '다시 로그인해주세요.',
    403: '태그를 관리할 권한이 없습니다.',
    404: '태그 또는 사용자를 찾을 수 없습니다.',
    409: '같은 이름의 태그가 있거나 다른 관리자가 먼저 변경했습니다.',
    422: '태그 이름은 1~30자, 사용자 태그는 최대 20개까지 저장할 수 있습니다.',
  }
  throw new Error(messages[response.status] ?? '태그 요청에 실패했습니다.')
}

async function write<T>(path: string, method: string, input: object) {
  const csrf = await adminFetch('/api/v1/admin/auth/csrf').then(decode<{ token: string; headerName: string }>)
  return adminFetch('/api/v1/admin' + path, {
    method, headers: { [csrf.headerName]: csrf.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }).then(decode<T>)
}

export function TagCatalog({ tags, changed }: { tags: Tag[]; changed: () => void }) {
  const [form] = Form.useForm<TagForm>()
  const { mark: markUnsaved, clear: clearUnsaved } = useAdminUnsaved(true)
  const [editing, setEditing] = useState<Tag>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  async function save({ name }: TagForm) {
    setError(undefined)
    setBusy(true)
    try {
      if (editing) await write('/tags/' + editing.id, 'PATCH', { name, expectedVersion: editing.version })
      else await write('/tags', 'POST', { name })
      clearUnsaved()
      form.resetFields()
      setEditing(undefined)
      changed()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '태그를 저장하지 못했습니다.')
    } finally {
      setBusy(false)
    }
  }

  return <Card size="small" title="태그 관리">
    {error && <Alert type="error" title={error} />}
    <Form form={form} layout="vertical" onValuesChange={(fields: Partial<TagForm>) => {
      if (fields.name !== undefined) markUnsaved()
    }} onFinish={save} disabled={busy}>
      <div className="admin-user-filters">
        <Form.Item name="tagId" label="수정할 태그">
          <Select allowClear placeholder="선택하지 않으면 새 태그 추가"
            options={tags.map((tag) => ({ value: tag.id, label: tag.name }))}
            onChange={(id) => {
              const tag = tags.find((item) => item.id === id)
              clearUnsaved()
              setEditing(tag)
              setError(undefined)
              form.setFieldsValue({ name: tag?.name ?? '' })
            }} />
        </Form.Item>
        <Form.Item name="name" label="태그 이름"
          rules={[{ required: true, whitespace: true, message: '태그 이름을 입력해주세요.' }]}>
          <Input maxLength={30} />
        </Form.Item>
      </div>
      <Space>
        <Button type="primary" htmlType="submit" loading={busy}>{editing ? '이름 저장' : '태그 추가'}</Button>
        <Button onClick={() => {
          clearUnsaved()
          form.resetFields()
          setEditing(undefined)
          setError(undefined)
          changed()
        }}>목록 갱신</Button>
      </Space>
    </Form>
  </Card>
}

export function UserTagEditor({ userId, tags, changed }: { userId: string; tags: Tag[]; changed: () => void }) {
  const [baseline, setBaseline] = useState<string[]>()
  const { mark: markUnsaved, clear: clearUnsaved } = useAdminUnsaved(baseline != null)
  const [selection, setSelection] = useState<string[]>([])
  const [revision, setRevision] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const path = '/users/' + userId + '/tags'

  useEffect(() => {
    const controller = new AbortController()
    void adminFetch('/api/v1/admin' + path, { signal: controller.signal }).then(decode<Selection>).then(({ tagIds }) => {
      if (controller.signal.aborted) return
      setBaseline(tagIds)
      setSelection(tagIds)
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '태그를 불러오지 못했습니다.')
    })
    return () => controller.abort()
  }, [path, revision])

  async function save() {
    if (!baseline || busy) return
    setBusy(true)
    setError(undefined)
    try {
      const result = await write<Selection>(path, 'PUT', { tagIds: selection, expectedTagIds: baseline })
      clearUnsaved()
      setBaseline(result.tagIds)
      setSelection(result.tagIds)
      changed()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '태그를 저장하지 못했습니다.')
    } finally {
      setBusy(false)
    }
  }

  return <Card size="small" title="사용자 태그">
    {error && <Alert type="error" title={error} />}
    <Space orientation="vertical" style={{ display: 'flex' }}>
      <Select mode="multiple" aria-label="사용자 태그 선택" maxCount={20} value={selection}
        style={{ width: '100%' }} disabled={!baseline || busy} onChange={(value) => { markUnsaved(); setSelection(value) }}
        options={tags.map((tag) => ({ value: tag.id, label: tag.name }))} />
      <Space>
        <Button type="primary" disabled={!baseline} loading={busy} onClick={() => void save()}>태그 저장</Button>
        <Button disabled={busy} onClick={() => {
          setError(undefined)
          setBaseline(undefined)
          setRevision((previous) => previous + 1)
        }}>다시 불러오기</Button>
      </Space>
    </Space>
  </Card>
}
