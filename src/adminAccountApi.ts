import { adminFetch } from './adminFetch'
const root = '/api/v1/admin'

export class AdminAccountError extends Error {
  readonly status: number

  constructor(status: number) {
    const messages: Record<number, string> = {
      401: '다시 로그인해주세요.',
      403: '요청을 수행할 권한이 없습니다.',
      404: '계정이나 초대 링크가 없거나 만료되었습니다.',
      409: '현재 상태에서는 변경할 수 없습니다. 다른 변경이나 마지막 활성 최고관리자 여부를 확인해주세요.',
      422: '입력한 값과 인증 코드를 확인해주세요.',
      428: '최근 MFA 인증이 필요합니다.',
      429: '인증 요청이 너무 많습니다. 잠시 후 다시 시도해주세요.',
      503: '비밀번호 유출 여부를 확인할 수 없습니다. 잠시 후 다시 시도해주세요.',
    }
    super(messages[status] ?? '관리자 요청을 완료하지 못했습니다.')
    this.status = status
  }
}

async function decode<T>(response: Response): Promise<T> {
  if (!response.ok) throw new AdminAccountError(response.status)
  return (response.status === 204 ? undefined : await response.json()) as T
}

export async function accountRead<T>(path: string, signal?: AbortSignal) {
  return decode<T>(await adminFetch(root + path, { cache: 'no-store', signal }))
}

export async function accountWrite<T>(path: string, method: 'POST' | 'PATCH', body?: object, key?: string) {
  const csrf = await accountRead<{ headerName: string; token: string }>('/auth/csrf')
  return decode<T>(await adminFetch(root + path, {
    method,
    headers: { [csrf.headerName]: csrf.token, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }))
}
