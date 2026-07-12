import { useRef, useState, type ReactNode } from 'react'

interface DropZoneProps {
  accept: string
  multiple?: boolean
  /** Compact single-row variant for secondary drop targets. */
  compact?: boolean
  onFiles: (files: File[]) => void
  children: ReactNode
}

/** Drag-and-drop (or click-to-browse) file input. */
export function DropZone({ accept, multiple = false, compact = false, onFiles, children }: DropZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)

  function handleFiles(list: FileList | null) {
    if (!list || list.length === 0) return
    onFiles(Array.from(list))
  }

  return (
    <div
      className={`drop${compact ? ' drop--compact' : ''}${over ? ' drop--over' : ''}`}
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        handleFiles(e.dataTransfer.files)
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        hidden
        onChange={(e) => {
          handleFiles(e.target.files)
          e.target.value = ''
        }}
      />
      {children}
    </div>
  )
}
