// The canvas toolbar entry for setups. It owns the trigger and the portal
// anchor, like the worktree menu: the popover body is mounted only while open.

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Layers } from 'lucide-react'
import {
  CanvasToolbarButton,
  type CanvasToolbarItemProps,
} from '../../client/layout/canvas'
import { SetupsPopover } from './SetupsDialog'

export const SetupsToolbarItem: React.FC<CanvasToolbarItemProps> = ({
  workspaceId,
  canvasPanelId,
  menuSide = 'up',
  tooltipPlacement,
  onOpenChange,
}) => {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)

  // Notify the toolbar only on real transitions (an open fly-out keeps a
  // compact toolbar expanded).
  const onOpenChangeRef = useRef(onOpenChange)
  onOpenChangeRef.current = onOpenChange
  useEffect(() => { onOpenChangeRef.current?.(open) }, [open])

  const toggle = useCallback(() => {
    if (open) {
      setOpen(false)
      return
    }
    const cardEl = btnRef.current?.closest('[data-toolbar-card]') as HTMLElement | null
    const rect = (cardEl ?? btnRef.current)?.getBoundingClientRect()
    if (rect) {
      setPos(menuSide === 'right'
        ? { left: Math.min(rect.right + 8, window.innerWidth - 388), bottom: window.innerHeight - rect.bottom }
        : { left: Math.max(8, Math.min(rect.left, window.innerWidth - 388)), bottom: window.innerHeight - rect.top + 10 })
    }
    setOpen(true)
  }, [open, menuSide])

  return (
    <>
      <CanvasToolbarButton
        ref={btnRef}
        onClick={toggle}
        active={open}
        label="Setups"
        tooltipPlacement={tooltipPlacement}
      >
        <Layers size={18} />
      </CanvasToolbarButton>
      {open && pos && createPortal(
        <SetupsPopover
          workspaceId={workspaceId}
          canvasPanelId={canvasPanelId}
          pos={pos}
          triggerRef={btnRef}
          onClose={() => setOpen(false)}
        />,
        document.body,
      )}
    </>
  )
}
