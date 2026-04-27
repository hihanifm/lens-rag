import { useMemo, useState } from 'react'
import { getProjectPin, setProjectPin, verifyProjectPin } from '../api/client'

export function useProjectPin(projectId, hasPin) {
  const needsPin = !!hasPin
  const storedPin = useMemo(() => {
    if (!projectId) return ''
    return getProjectPin(projectId)
  }, [projectId])

  const [locked, setLocked] = useState(() => needsPin && !storedPin)

  const unlockWithPin = async (pin) => {
    await verifyProjectPin(projectId, pin)
    setProjectPin(projectId, pin)
    setLocked(false)
  }

  return { isLocked: locked, unlockWithPin }
}

