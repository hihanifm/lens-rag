import { useEffect, useState } from 'react'
import { getProjectPin, setProjectPin, verifyProjectPin } from '../api/client'

export function useProjectPin(projectId, hasPin) {
  const [locked, setLocked] = useState(false)

  // hasPin is undefined while project is still loading; only set locked state
  // once we know for sure whether a PIN is required.
  useEffect(() => {
    if (hasPin == null) return
    setLocked(hasPin && !getProjectPin(projectId))
  }, [projectId, hasPin])

  const unlockWithPin = async (pin) => {
    await verifyProjectPin(projectId, pin)
    setProjectPin(projectId, pin)
    setLocked(false)
  }

  return { isLocked: locked, unlockWithPin }
}
