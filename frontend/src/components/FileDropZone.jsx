import { useRef, useState } from 'react'

/** Tray + arrow-up icon (matches common “upload” affordance). */
function UploadTrayIcon({ className }) {
  return (
    <svg
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.5}
      stroke="currentColor"
      aria-hidden
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l3 3m-3-3v12"
      />
    </svg>
  )
}

/**
 * Consistent drag-and-drop upload surface (light blue tint, dashed border, bold “click to browse”).
 *
 * @param {object} props
 * @param {string} props.accept - input accept string, e.g. ".xlsx,.xls"
 * @param {string} props.formatLabel - bold fragment in primary line, e.g. ".xlsx / .xls" or ".csv"
 * @param {boolean} [props.multiple=false]
 * @param {(f: File) => void} props.onFile
 * @param {import('react').ReactNode} [props.selectedDisplay] - when set, replaces empty-state copy (success / loaded summary)
 * @param {import('react').ReactNode} [props.children] - e.g. sample loaders below the primary text
 * @param {import('react').ReactNode} [props.tailHint] - replaces “One file at a time” / “Multiple files supported”
 * @param {string} [props.className]
 * @param {string} [props.inputTestId]
 * @param {string} [props.inputId]
 */
export function FileDropZone({
  accept,
  formatLabel,
  multiple = false,
  onFile,
  selectedDisplay = null,
  children,
  tailHint,
  className = '',
  inputTestId,
  inputId,
}) {
  const inputRef = useRef(null)
  const [dragging, setDragging] = useState(false)

  const openPicker = () => inputRef.current?.click()

  const handleFiles = (fileList) => {
    const list = fileList ? Array.from(fileList) : []
    if (!list.length) return
    onFile(multiple ? list : list[0])
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          openPicker()
        }
      }}
      onClick={openPicker}
      onDragEnter={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setDragging(true)
      }}
      onDragOver={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setDragging(true)
      }}
      onDragLeave={(e) => {
        e.preventDefault()
        setDragging(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setDragging(false)
        handleFiles(e.dataTransfer.files)
      }}
      className={`
        border-2 border-dashed rounded-xl py-10 px-6 text-center cursor-pointer transition-colors
        ${dragging ? 'border-sky-400 bg-sky-50' : 'border-gray-300 bg-sky-50/60 hover:border-sky-400 hover:bg-sky-50'}
        ${className}
      `}
    >
      <input
        id={inputId}
        ref={inputRef}
        data-testid={inputTestId}
        type="file"
        accept={accept}
        multiple={multiple}
        className="hidden"
        onChange={(e) => {
          handleFiles(e.target.files)
          e.target.value = ''
        }}
        onClick={(e) => e.stopPropagation()}
      />

      {selectedDisplay ? (
        <div className="space-y-1 text-center">
          {selectedDisplay}
          <p className="text-xs text-gray-500">Click to change</p>
        </div>
      ) : (
        <>
          <UploadTrayIcon className="mx-auto h-10 w-10 text-gray-400 mb-3" />
          <p className="text-sm text-gray-700">
            Drag &amp; drop <span className="font-bold text-gray-900">{formatLabel}</span> files here, or{' '}
            <span className="font-bold text-gray-900">click to browse</span>
          </p>
          <p className="text-xs text-gray-500 mt-2">
            {tailHint ?? (multiple ? 'Multiple files supported' : 'One file at a time')}
          </p>
        </>
      )}

      {children ? <div className="mt-6">{children}</div> : null}
    </div>
  )
}
