import { adminFetch } from './adminFetch'
export async function exportWrite<T>(path: string, body: object, key?: string): Promise<T> {
  const csrf = await adminFetch('/api/v1/admin/auth/csrf', { cache: 'no-store' })
  if (!csrf.ok) throw new Error('관리자 요청을 준비하지 못했습니다.')
  const { headerName, token } = await csrf.json() as { headerName: string; token: string }
  const response = await adminFetch('/api/v1/admin' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [headerName]: token, ...(key ? { 'Idempotency-Key': key } : {}) },
    body: JSON.stringify(body),
  })
  if (response.ok) return response.json() as Promise<T>
  if (path.startsWith('/deletion-requests/')) {
    const messages: Record<number, string> = {
      401: '다시 로그인해주세요.',
      403: '삭제 작업 재접수 권한이 없습니다.',
      404: '조회 가능한 삭제 작업이 없습니다.',
      409: '작업 상태가 바뀌었습니다. 작업 모니터를 갱신해주세요.',
      422: '재접수 사유와 작업 상태를 확인해주세요.',
    }
    throw new Error(messages[response.status] ?? '삭제 작업을 재접수하지 못했습니다.')
  }
  const messages: Record<number, string> = {
    401: '다시 로그인해주세요.',
    403: '내보내기 권한이 없습니다.',
    404: path.startsWith('/jobs/') ? '조회 가능한 작업 기록이 없습니다.' : '내보내기 파일이 만료되었거나 다운로드할 수 없습니다.',
    409: '작업 상태가 바뀌었거나 같은 필터로 요청한 작업이 대기 중입니다. 작업 모니터를 갱신해주세요.',
    422: '내보내기 요청 값을 확인해주세요.',
  }
  throw new Error(messages[response.status] ?? '내보내기 요청을 완료하지 못했습니다.')
}
