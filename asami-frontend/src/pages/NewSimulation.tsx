import { useState } from 'react'
import { ArrowRight, Gauge, Sparkles } from 'lucide-react'
import { PageTitle, Panel } from '../components/Ui'

export function NewSimulation({ onCreate, onCancel }: { onCreate: (payload: Record<string, unknown>) => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState('Asami — New Life')
  const [speed, setSpeed] = useState(60)
  const [description, setDescription] = useState('Autonomous simulated person')
  const [firstName, setFirstName] = useState('Asami')
  const [lastName, setLastName] = useState('')
  const [start, setStart] = useState(() => new Date().toISOString().slice(0, 16))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    setSaving(true); setError(null)
    try { await onCreate({ name, startedSimulationAt: new Date(start).toISOString(), asami: { name: firstName, firstName, lastName: lastName || null, description, speed } }) } catch (e) { setError(e instanceof Error ? e.message : 'Creazione fallita.') } finally { setSaving(false) }
  }
  return <div className="new-sim-wrap"><PageTitle eyebrow="SIMULATION FACTORY" title="Start a new life" description="Questi valori vengono passati direttamente al POST /api/simulations del backend." action={<button className="ghost-button" onClick={onCancel}>Annulla</button>} /><div className="new-sim-grid"><Panel title="Simulation identity" eyebrow="WORLD CONFIGURATION"><div className="form-grid"><label>Simulation name<input value={name} onChange={(e) => setName(e.target.value)} /></label><label>Simulation start<input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} /></label><label>Asami first name<input value={firstName} onChange={(e) => setFirstName(e.target.value)} /></label><label>Last name<input value={lastName} onChange={(e) => setLastName(e.target.value)} /></label><label className="wide">Description<textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} /></label></div></Panel><Panel title="Clock" eyebrow="SIMULATION TIME"><div className="speed-selector"><div className="speed-icon"><Gauge size={18} /></div><div><strong>Default speed ×{speed}</strong><span>Real seconds converted to simulated time.</span></div><select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>{[1, 2, 5, 10, 30, 60, 120, 300].map((x) => <option key={x} value={x}>×{x}</option>)}</select></div><div className="callout"><Sparkles size={16} /><span>Il clock viene persistito nei segmenti del database: il frontend non simula il tempo localmente.</span></div><button className="primary-button wide-button" disabled={saving || !name.trim() || !firstName.trim()} onClick={() => void submit()}>{saving ? 'Creazione…' : <>Create simulation <ArrowRight size={16} /></>}</button>{error && <div className="composer-error">{error}</div>}</Panel></div></div>
}
