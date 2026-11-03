import { useCallback, useEffect, useState } from 'react'
import type { AutoTagState } from './autoTagTypes'

const API = '/__library/auto-tag'
async function request<T>(route = '', body?: unknown): Promise<T> {
  const res = await fetch(`${API}${route}`, body === undefined ? { cache: 'no-store' } : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `Scanner request failed (${res.status})`)
  return data as T
}
export function useAutoTag() {
  const [state, setState] = useState<AutoTagState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const refresh = useCallback(async () => { setState(await request<AutoTagState>()) }, [])
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      let busy = false
      try {
        const next = await request<AutoTagState>()
        if (alive) { setState(next); busy = next.job?.status === 'running' }
      } catch (e) { if (alive) setError((e as Error).message) }
      if (alive) timer = setTimeout(poll, busy ? 1200 : 5000)
    }
    void poll()
    return () => { alive = false; clearTimeout(timer) }
  }, [])
  const action = useCallback(async (route: string, body: unknown = {}) => {
    setSubmitting(true); setError(null)
    try { await request(route, body); await refresh(); return true }
    catch (e) { setError((e as Error).message); return false }
    finally { setSubmitting(false) }
  }, [refresh])
  return { state, error, submitting, refresh, action }
}
