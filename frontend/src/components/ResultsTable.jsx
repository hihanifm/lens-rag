import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
} from '@tanstack/react-table'
import { useMemo, useState } from 'react'

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

  const columns = useMemo(() =>
    displayColumns.map(col => ({
      accessorFn: row => row.display_data[col],
      id: col,
      header: col,
      cell: info => {
        const expanded = expandedRows.has(info.row.id)
        return (
          <span
            className={`block text-sm text-gray-700 break-words ${
              expanded ? 'whitespace-pre-wrap' : 'whitespace-normal line-clamp-5'
            }`}
          >
            {info.getValue() ?? ''}
          </span>
        )
      }
    })),
    [displayColumns, expandedRows]
  )

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
    <div className="overflow-x-auto rounded-xl border border-gray-200 mt-6">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          {table.getHeaderGroups().map(hg => (
            <tr key={hg.id}>
              {hg.headers.map(header => (
                <th
                  key={header.id}
                  onClick={header.column.getToggleSortingHandler()}
                  className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider cursor-pointer select-none hover:bg-gray-100"
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
              onClick={() => toggleRow(row.id)}
              className={`${i % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'} hover:bg-blue-50/40 cursor-pointer transition-colors`}
              title="Click to expand/collapse row"
            >
              {row.getVisibleCells().map(cell => (
                <td key={cell.id} className="px-4 py-3 max-w-xs align-top">
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
