import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
} from '@tanstack/react-table'
import { useMemo, useState } from 'react'

function ScoreBubble({ label, value, title, className }) {
  if (value == null || value === '—') return null
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full border whitespace-nowrap ${className}`}
    >
      <span className="opacity-70">{label}</span>
      <span className="tabular-nums">{value}</span>
    </span>
  )
}

function rerankStrengthLabel(rank) {
  if (typeof rank !== 'number') return null
  if (rank === 1) return 'strong'
  if (rank <= 3) return 'good'
  if (rank <= 10) return 'ok'
  return 'weak'
}

export default function ResultsTable({ results, displayColumns }) {
  const [sorting, setSorting] = useState([])
  const [expandedRows, setExpandedRows] = useState(new Set())

  const toggleRow = (rowId) => {
    setExpandedRows(prev => {
      const next = new Set(prev)
      next.has(rowId) ? next.delete(rowId) : next.add(rowId)
      return next
    })
  }

  const columns = useMemo(() => {
    const hasAnyScores = Array.isArray(results) && results.some(r =>
      r?.cosine_score != null || r?.bm25_rank != null || r?.rerank_score != null
    )

    const rerankRankByRow = (() => {
      if (!Array.isArray(results)) return new Map()
      const pairs = results
        .map((r, idx) => ({ idx, score: r?.rerank_score }))
        .filter(p => typeof p.score === 'number' && !Number.isNaN(p.score))
        .sort((a, b) => Number(b.score) - Number(a.score))
      const m = new Map()
      pairs.forEach((p, i) => m.set(p.idx, i + 1))
      return m
    })()

    const scoreCol = hasAnyScores ? [{
      id: '__scores',
      header: '',
      accessorFn: row => row,
      cell: info => {
        const row = info.getValue()
        const expanded = expandedRows.has(info.row.id)
        const cos = typeof row?.cosine_score === 'number' ? `${Math.round(row.cosine_score * 100)}%` : null
        const bm25 = typeof row?.bm25_rank === 'number' ? `#${row.bm25_rank}` : null
        const rrScore = typeof row?.rerank_score === 'number' ? row.rerank_score : null
        const rrScoreTxt = typeof rrScore === 'number' && !Number.isNaN(rrScore) ? rrScore.toFixed(3) : null
        const rrRank = rerankRankByRow.get(info.row.index) ?? null
        const rrStrength = rerankStrengthLabel(rrRank)
        const rrValue = rrScoreTxt
          ? `${rrStrength ? `${rrStrength} · ` : ''}${rrRank ? `#${rrRank} · ` : ''}${rrScoreTxt}`
          : null

        return (
          <div className="flex flex-col gap-1 items-start">
            <button
              type="button"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleRow(info.row.id) }}
              className="inline-flex items-center justify-center w-6 h-6 rounded-md border border-gray-200 bg-white text-gray-500 hover:bg-gray-50 hover:text-gray-700 transition-colors"
              title={expanded ? 'Collapse row' : 'Expand row'}
              aria-label={expanded ? 'Collapse row' : 'Expand row'}
            >
              {expanded ? '−' : '+'}
            </button>
            <ScoreBubble
              label="cos"
              value={cos}
              title="Vector cosine similarity"
              className="bg-white text-gray-700 border-gray-200"
            />
            <ScoreBubble
              label="bm25"
              value={bm25}
              title="BM25 rank (lower is better)"
              className="bg-amber-50 text-amber-700 border-amber-200"
            />
            <ScoreBubble
              label="rerank"
              value={rrValue}
              title="Rerank: within-this-results rank and raw score (scale is model-dependent)"
              className="bg-emerald-50 text-emerald-700 border-emerald-200"
            />
          </div>
        )
      },
    }] : []

    return [
      ...scoreCol,
      ...displayColumns.map(col => ({
        accessorFn: row => row.display_data[col],
        id: col,
        header: col,
        cell: info => {
          const expanded = expandedRows.has(info.row.id)
          return (
            <span
              className={`block text-sm text-gray-700 break-words ${
                expanded ? 'whitespace-pre-wrap' : 'whitespace-normal line-clamp-5 lens-clamp-5'
              }`}
            >
              {info.getValue() ?? ''}
            </span>
          )
        }
      })),
    ]
  }, [displayColumns, expandedRows, results])

  const table = useReactTable({
    data: results,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })

  if (!results || results.length === 0) return null

  return (
    <div className="overflow-x-auto rounded-xl border border-gray-200 mt-6 pb-2">
      <table
        className="divide-y divide-gray-200"
        style={{ width: 'max-content', minWidth: '100%' }}
      >
        <thead className="bg-gray-50">
          {table.getHeaderGroups().map(hg => (
            <tr key={hg.id}>
              {hg.headers.map(header => (
                <th
                  key={header.id}
                  onClick={header.column.getToggleSortingHandler()}
                  className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider cursor-pointer select-none hover:bg-gray-100 min-w-[160px]"
                >
                  <div className="flex items-center gap-1">
                    {flexRender(header.column.columnDef.header, header.getContext())}
                    {header.column.getIsSorted() === 'asc' && <span>↑</span>}
                    {header.column.getIsSorted() === 'desc' && <span>↓</span>}
                  </div>
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody className="bg-white divide-y divide-gray-100">
          {table.getRowModel().rows.map((row, i) => (
            <tr
              key={row.id}
              className={`${i % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'} hover:bg-blue-50/40 transition-colors`}
            >
              {row.getVisibleCells().map(cell => (
                <td
                  key={cell.id}
                  className={`px-4 py-3 align-top ${
                    cell.column.id === '__scores'
                      ? 'min-w-[120px] w-[120px] px-2'
                      : 'min-w-[160px] max-w-xs'
                  }`}
                >
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
