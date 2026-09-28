import * as m from 'motion/react-m'
import { transitions } from '../../../app/motion'
import { useSettle } from './drop-feedback'

// After a drop, an outline slides from the highlight that was dropped on to the pane the drop
// produced, then fades: the eye follows the move. It holds no content, so scaling it costs nothing.
export function DropSettle() {
  const settle = useSettle()
  if (!settle) return null
  const { from, to, key } = settle
  return (
    <m.div
      key={key}
      aria-hidden
      data-drop-settle
      className="pointer-events-none fixed z-50 origin-top-left rounded-xl bg-accent"
      style={{ left: to.left, top: to.top, width: to.width, height: to.height }}
      initial={{
        x: from.left - to.left,
        y: from.top - to.top,
        scaleX: from.width / to.width,
        scaleY: from.height / to.height,
        opacity: 0.6,
      }}
      animate={{ x: 0, y: 0, scaleX: 1, scaleY: 1, opacity: 0 }}
      transition={transitions.settle}
      onAnimationComplete={() => useSettle.setState(null, true)}
    />
  )
}
