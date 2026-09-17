import { Activity, Sparkles } from 'lucide-react'

export function Brand() {
  return (
    <div className="brand">
      <div className="brand-mark"><Sparkles size={17} /></div>
      <div>
        <div className="brand-name">ASAMI</div>
        <div className="brand-sub">SIMULAZIONE DI VITA AUTONOMA</div>
      </div>
      <div className="brand-pulse"><Activity size={13} /> ATTIVA</div>
    </div>
  )
}
