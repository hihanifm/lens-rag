import { useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { getProject, runEvaluation } from '../api/client'
import { API_BASE_URL } from '../api/client'

export default function EvaluateProject() {
  const { projectId } = useParams()
  const [testCases, setTestCases] = useState(null)
  const [k, setK] = useState(10)
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState(null)
  const [error, setError] = useState('')

  const { data: project } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => getProject(projectId)
  })

  const parseCSVLine = (line) => {
    const result = []
    let current = ''
    let inQuotes = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { current += '"'; i++ }
        else inQuotes = !inQuotes
      } else if (ch === ',' && !inQuotes) {
        result.push(current); current = ''
      } else {
        current += ch
      }
    }
    result.push(current)
    return result
  }

  const handleFileUpload = (e) => {
    const file = e.target.files[0]
    if (!file) return
    setError('')
    setResults(null)
    const reader = new FileReader()
    reader.onload = (ev) => {
      try {
        const lines = ev.target.result.trim().split(/\r?\n/)
        const headers = parseCSVLine(lines[0]).map(h => h.trim())
        if (!headers.includes('question') || !headers.includes('ground_truth')) {
          setError('CSV must have "question" and "ground_truth" columns.')
          return
        }
        const qi = headers.indexOf('question')
        const gi = headers.indexOf('ground_truth')
        const parsed = lines.slice(1).filter(l => l.trim()).map(line => {
          const vals = parseCSVLine(line)
          return { question: vals[qi]?.trim(), ground_truth: vals[gi]?.trim() }
        }).filter(r => r.question && r.ground_truth)
        if (!parsed.length) { setError('No valid rows found in CSV.'); return }
        setTestCases(parsed)
      } catch {
        setError('Could not parse CSV file.')
      }
    }
    reader.readAsText(file)
  }

  const handleRun = async () => {
    if (!testCases?.length) return
    setLoading(true)
    setError('')
    setResults(null)
    try {
      const data = await runEvaluation(projectId, testCases, k)
      setResults(data)
    } catch {
      setError('Evaluation failed. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const handleExport = () => {
    if (!results) return
    const blob = new Blob([JSON.stringify(results, null, 2)], { type: 'application/json' })
    const url = window.URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.setAttribute('download', 'lens_ragas_export.json')
    document.body.appendChild(link)
    link.click()
    link.remove()
  }

  if (!project) return <div className="p-8 text-gray-400">Loading...</div>

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-6xl mx-auto px-6 py-10">

        {/* Header */}
        <div className="mb-8">
          <Link to="/" className="text-sm text-gray-400 hover:text-gray-600">← Projects</Link>
          <h1 className="text-2xl font-bold text-gray-900 mt-1">{project.name}</h1>
          <p className="text-sm text-gray-400 mb-4">{project.row_count?.toLocaleString()} records</p>
          <div className="flex gap-1">
            <Link
              to={`/projects/${projectId}/search`}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors"
            >
              Search
            </Link>
            <Link
              to={`/projects/${projectId}/evaluate`}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 text-white transition-colors"
            >
              Evaluate
            </Link>
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-gray-200 p-6 shadow-sm max-w-2xl">

          {/* Test set upload */}
          <h2 className="text-base font-semibold text-gray-900 mb-1">Test Set</h2>
          <p className="text-sm text-gray-500 mb-4">
            Upload a CSV with <code className="bg-gray-100 px-1 rounded text-xs">question</code> and <code className="bg-gray-100 px-1 rounded text-xs">ground_truth</code> columns.
          </p>

          <div
            className="border-2 border-dashed border-gray-300 rounded-xl p-8 text-center cursor-pointer hover:border-blue-400 transition-colors mb-2"
            onClick={() => document.getElementById('eval-file-input').click()}
          >
            {testCases ? (
              <p className="text-gray-700 font-medium">{testCases.length} question{testCases.length !== 1 ? 's' : ''} loaded</p>
            ) : (
              <p className="text-gray-400 text-sm">Click to upload test set CSV</p>
            )}
            <input id="eval-file-input" type="file" accept=".csv" className="hidden" onChange={handleFileUpload} />
          </div>

          <a
            href={`${API_BASE_URL}/samples/product_catalog_testset.csv`}
            download
            className="text-xs text-blue-500 hover:text-blue-700"
          >
            Download product catalog sample test set ↗
          </a>

          {/* K selector */}
          <div className="flex items-center gap-3 mt-6 mb-6">
            <span className="text-sm text-gray-500">Results per question (k):</span>
            {[5, 10, 20, 50].map(val => (
              <button
                key={val}
                onClick={() => setK(val)}
                className={`text-sm px-3 py-1 rounded-lg transition-colors ${
                  k === val ? 'bg-blue-100 text-blue-700 font-medium' : 'text-gray-500 hover:bg-gray-100'
                }`}
              >
                {val}
              </button>
            ))}
          </div>

          {/* Action buttons */}
          <div className="flex gap-3">
            <button
              onClick={handleRun}
              disabled={!testCases || loading}
              className="flex-1 bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-40 transition-colors"
            >
              {loading ? `Running ${testCases?.length} searches...` : 'Run Evaluation'}
            </button>
            <button
              onClick={handleExport}
              disabled={!results}
              className="flex-1 border border-gray-300 text-gray-700 py-3 rounded-lg font-medium hover:bg-gray-50 disabled:opacity-40 transition-colors"
            >
              Export RAGAS JSON
            </button>
          </div>

          {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
        </div>

        {/* Results */}
        {results && (
          <div className="mt-6 bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden max-w-2xl">
            <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
              <h2 className="text-base font-semibold text-gray-900">Results</h2>
              <span className="text-sm text-gray-400">{results.length} questions · k={k}</span>
            </div>
            <div className="divide-y divide-gray-100">
              {results.map((r, i) => (
                <div key={i} className="px-6 py-4">
                  <p className="text-sm font-medium text-gray-800 mb-1">{r.question}</p>
                  <p className="text-xs text-gray-400">{r.contexts.length} context{r.contexts.length !== 1 ? 's' : ''} retrieved</p>
                  <p className="text-xs text-gray-400 mt-1 truncate">{r.contexts[0]}</p>
                </div>
              ))}
            </div>
            <div className="px-6 py-4 bg-gray-50 border-t border-gray-100">
              <p className="text-xs text-gray-500">
                Export the JSON and run <code className="bg-gray-200 px-1 rounded">ragas evaluate</code> locally to get precision and recall scores.
              </p>
            </div>
          </div>
        )}

        {/* How to evaluate */}
        <div className="mt-6 max-w-2xl">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">How to evaluate locally</h3>
          <pre className="bg-white border border-gray-200 rounded-xl p-4 text-xs text-gray-600 overflow-x-auto leading-relaxed shadow-sm">{`pip install ragas datasets langchain-openai

from datasets import Dataset
from ragas import evaluate
from ragas.metrics import context_precision, context_recall
import json

with open("lens_ragas_export.json") as f:
    data = json.load(f)

dataset = Dataset.from_list(data)
results = evaluate(dataset, metrics=[context_precision, context_recall])
print(results)

# save scores to CSV
results.to_pandas().to_csv("ragas_scores.csv", index=False)`}</pre>
        </div>

      </div>
    </div>
  )
}
