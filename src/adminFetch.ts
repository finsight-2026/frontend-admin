export const adminSessionExpired = 'finsight:admin-session-expired'
export const adminRequestDelay = 'finsight:admin-request-delay'

export async function adminFetch(input: string, options?: RequestInit): Promise<Response> {
  const route = new URL(input, window.location.origin)
  const isProtected = route.origin === window.location.origin &&
    route.pathname.startsWith('/api/v1/admin/') && !route.pathname.startsWith('/api/v1/admin/auth/')
  if (!isProtected) return fetch(input, options)

  const read = (options?.method ?? 'GET').toUpperCase() === 'GET'
  const controller = new AbortController()
  const signal = options?.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
  const request = fetch(input, { cache: 'no-store', ...options, signal })
  const id = Symbol()
  let delayed = false
  let retry: (() => void) | undefined
  const retryRequest = read ? new Promise<undefined>((resolve) => {
    retry = () => {
      if (signal.aborted || !retry) return
      retry = undefined
      resolve(undefined)
    }
  }) : undefined
  const notifyDelay = (pending: boolean) => window.dispatchEvent(new CustomEvent(adminRequestDelay, {
    detail: { id, pending, retry },
  }))
  const timeout = window.setTimeout(() => {
    delayed = true
    notifyDelay(true)
  }, 10_000)
  try {
    const response = await (retryRequest ? Promise.race([request, retryRequest]) : request)
    if (!response) {
      controller.abort()
      return adminFetch(input, options)
    }
    if (response.status === 401 && !options?.signal?.aborted) {
      window.dispatchEvent(new Event(adminSessionExpired))
    }
    return response
  } finally {
    retry = undefined
    window.clearTimeout(timeout)
    if (delayed) notifyDelay(false)
  }
}
