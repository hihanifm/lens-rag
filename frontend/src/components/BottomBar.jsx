import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { createPortal } from 'react-dom'
import { getHealth } from '../api/client'

export default function BottomBar() {
  const { data, isError } = useQuery({
    queryKey: ['health'],
    queryFn: getHealth,
    refetchInterval: 30000,
    retry: false,
  })

  const online = !isError && data?.status === 'ok'
  const version = data?.version ?? '—'
  const mode = import.meta.env.PROD ? 'PROD' : 'DEV'
  const uptimeS = typeof data?.uptime_s === 'number' ? data.uptime_s : null

  const fmtUptime = (s) => {
    if (s === null) return '—'
    const hrs = Math.floor(s / 3600)
    const mins = Math.floor((s % 3600) / 60)
    const secs = s % 60
    if (hrs > 0) return `${hrs}h ${mins}m`
    if (mins > 0) return `${mins}m ${secs}s`
    return `${secs}s`
  }

  const bar = (
    <div className="fixed bottom-0 left-0 right-0 z-30 h-8 bg-gray-100 border-t border-gray-200 px-4 text-xs text-gray-500">
      <div className="relative h-full flex items-center justify-between">
        <div className="flex items-center gap-3">
        <Link to="/" className="font-semibold text-gray-700 hover:text-gray-900 tracking-tight transition-colors">LENS</Link>
        <span className="px-1.5 py-0.5 rounded border border-amber-200 bg-amber-50 text-amber-700 font-medium tracking-wide">
          BETA
        </span>
        <span className="text-gray-300">·</span>
        <span className={`px-2 py-0.5 rounded-full border font-medium tracking-wide
          ${mode === 'PROD' ? 'bg-violet-50 border-violet-200 text-violet-700' : 'bg-sky-50 border-sky-200 text-sky-700'}`}>
          {mode}
        </span>
        <span className="text-gray-300">·</span>
        <span className={`inline-block w-2 h-2 rounded-full ${online ? 'bg-emerald-400' : 'bg-red-400'}`} />
        <span>API {online ? 'online' : 'offline'}</span>
        <span className="text-gray-300">·</span>
        <span>up {fmtUptime(uptimeS)}</span>
        <span className="text-gray-300">·</span>
        <span>v{version}</span>
      </div>

      <div className="absolute left-1/2 -translate-x-1/2 italic whitespace-nowrap pointer-events-none">
        Excel + Lens = Excellence!
      </div>

        <div className="flex items-center gap-4">
        <Link to="/history" className="hover:text-gray-700 transition-colors">
          History
        </Link>
        <a
          href="https://github.com/hihanifm/lens-rag"
          target="_blank"
          rel="noreferrer"
          className="hover:text-gray-700 transition-colors"
        >
          GitHub ↗
        </a>
      </div>
      </div>
    </div>
  )

  // Render into document.body so `position: fixed` is truly viewport-fixed,
  // even if any ancestor creates a new containing block (e.g. via transform).
  return createPortal(bar, document.body)
}
