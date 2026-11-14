import { useAdminUnsaved } from './adminNavigation'
import { adminFetch } from './adminFetch'
import { Alert, Button, Card, Form, Input, List, Space, Typography } from 'antd'
import { useEffect, useRef, useState } from 'react'

type Note = {
  id: string; authorId: string; text: string; version: number; createdAt: string; updatedAt: string
}
type Editor = { action: 'CREATE' } | { action: 'EDIT' | 'DELETE'; note: Note }
const time = new Intl.DateTimeFormat('ko-KR', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Seoul',
})

async function checked(response: Response) {
  if (response.ok) return response
  const messages: Record<number, string> = {
    401: '다시 로그인해주세요.',
    403: '이 메모를 변경할 권한이 없습니다.',
    404: '사용자 또는 메모를 찾을 수 없습니다.',
    409: '메모가 이미 변경되었습니다. 새로고침 후 다시 시도해주세요.',
    422: 'HTML 없이 1~500자로 입력해주세요.',
    503: '서버에 운영 메모 암호화 키가 설정되어 있지 않습니다.',
  }
  throw new Error(messages[response.status] ?? '운영 메모 요청에 실패했습니다.')
}

export default function AdminUserNotes({ userId, actorId, supervisor }: {
  userId: string; actorId: string; supervisor: boolean
}) {
  const root = '/api/v1/admin/users/' + userId + '/notes'
  const [form] = Form.useForm<{ text: string }>()
  const [notes, setNotes] = useState<Note[]>([])
  const [editor, setEditor] = useState<Editor>()
  const { mark: markUnsaved, clear: clearUnsaved } = useAdminUnsaved(editor != null)
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const createRequest = useRef<{ text: string; key: string } | undefined>(undefined)
  const report = (failure: unknown) => setError(failure instanceof Error ? failure.message : '메모 요청에 실패했습니다.')

  useEffect(() => {
    const controller = new AbortController()
    void adminFetch(root, { signal: controller.signal }).then(checked).then(async (response) => {
      const rows = await response.json() as Note[]
      if (!controller.signal.aborted) setNotes(rows)
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) report(failure)
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false)
    })
    return () => controller.abort()
  }, [root, revision])

  function open(next: Editor) {
    clearUnsaved()
    setError(undefined)
    createRequest.current = undefined
    form.setFieldsValue({ text: next.action === 'EDIT' ? next.note.text : '' })
    setEditor(next)
  }

  function reload() {
    setError(undefined)
    setLoading(true)
    setRevision((current) => current + 1)
  }

  async function save({ text }: { text: string }) {
    if (!editor || busy) return
    setBusy(true)
    setError(undefined)
    try {
      const csrf = await adminFetch('/api/v1/admin/auth/csrf').then(checked)
        .then((response) => response.json() as Promise<{ headerName: string; token: string }>)
      const headers = { 'Content-Type': 'application/json', [csrf.headerName]: csrf.token }
      let response: Response
      if (editor.action === 'CREATE') {
        const normalized = text.trim()
        if (createRequest.current?.text !== normalized) {
          createRequest.current = { text: normalized, key: crypto.randomUUID() }
        }
        response = await adminFetch(root, {
          method: 'POST', headers: { ...headers, 'Idempotency-Key': createRequest.current.key },
          body: JSON.stringify({ text: normalized }),
        })
      } else {
        const body = editor.action === 'EDIT'
          ? { text, expectedVersion: editor.note.version }
          : { reason: text, expectedVersion: editor.note.version }
        response = await adminFetch(root + '/' + editor.note.id, {
          method: editor.action === 'EDIT' ? 'PATCH' : 'DELETE', headers, body: JSON.stringify(body),
        })
      }
      await checked(response)
      setEditor(undefined)
      form.resetFields()
      reload()
    } catch (failure) {
      report(failure)
    } finally {
      setBusy(false)
    }
  }

  return <Card size="small" title="운영 메모" extra={<Space>
    <Button loading={loading} disabled={busy} onClick={reload}>새로고침</Button>
    <Button disabled={busy} onClick={() => open({ action: 'CREATE' })}>메모 작성</Button>
  </Space>}>
    {error && <Alert type="error" showIcon title={error} />}
    {editor && <Form form={form} layout="vertical" onValuesChange={markUnsaved} onFinish={save} disabled={busy}>
      <Form.Item name="text" label={editor.action === 'DELETE' ? '삭제 사유' : '메모'}
        rules={[{ required: true, whitespace: true, message: '내용을 입력해주세요.' }]}>
        <Input.TextArea maxLength={500} showCount autoSize={{ minRows: 3 }} />
      </Form.Item>
      <Space>
        <Button type="primary" htmlType="submit" danger={editor.action === 'DELETE'} loading={busy}>
          {editor.action === 'DELETE' ? '삭제 확인' : '저장'}
        </Button>
        <Button onClick={() => setEditor(undefined)}>취소</Button>
      </Space>
    </Form>}
    <List<Note> loading={loading} dataSource={notes} locale={{ emptyText: '운영 메모 없음' }}
      rowKey="id" renderItem={(note) => {
        const editable = supervisor || note.authorId === actorId
        return <List.Item actions={editable ? [
          <Button key="edit" disabled={busy} onClick={() => open({ action: 'EDIT', note })}>수정</Button>,
          <Button key="delete" disabled={busy} danger onClick={() => open({ action: 'DELETE', note })}>삭제</Button>,
        ] : []}>
          <div>
            <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{note.text}</Typography.Paragraph>
            <Typography.Text type="secondary">{time.format(new Date(note.updatedAt))} · {note.authorId}</Typography.Text>
          </div>
        </List.Item>
      }} />
  </Card>
}
