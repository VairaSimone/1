import { Activity, Sparkles } from 'lucide-react'

export function Brand() {
  return (
    <div className="brand">
      <div className="brand-mark"><Sparkles size={17} /></div>
      <div>
        <div className="brand-name">ASAMI</div>
        <div className="brand-sub">AUTONOMOUS LIFE SIMULATION</div>
      </div>
      <div className="brand-pulse"><Activity size={13} /> LIVE</div>
    </div>
  )
}
