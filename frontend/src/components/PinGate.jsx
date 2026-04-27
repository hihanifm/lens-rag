import { useState } from 'react'

export default function PinGate({ onUnlock }) {
  const [pin, setPin] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e) => {
    e?.preventDefault()
    if (!pin) return
    setLoading(true)
    setError('')
    try {
      await onUnlock(pin)
    } catch (err) {
      setError('Incorrect PIN.')
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-6">
      <div className="w-full max-w-md bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
        <div className="flex items-start gap-3 mb-4">
          <div className="shrink-0 w-10 h-10 rounded-xl bg-gray-100 flex items-center justify-center text-gray-600">
            🔒
          </div>
          <div>
            <h1 className="text-lg font-semibold text-gray-900">This project is PIN protected</h1>
            <p className="text-sm text-gray-500 mt-1">Enter the PIN to unlock access.</p>
          </div>
        </div>

        <form onSubmit={submit} className="space-y-3">
          <input
            type="password"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder="PIN"
            className="w-full border border-gray-300 rounded-lg px-4 py-3 text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
            autoFocus
          />

          <button
            type="submit"
            disabled={loading || !pin}
            className="w-full bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-40 transition-colors"
          >
            {loading ? 'Unlocking...' : 'Unlock'}
          </button>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm">
              {error}
            </div>
          )}
        </form>
      </div>
    </div>
  )
}

