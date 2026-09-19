import { useState } from 'react'

function localDateTimeValue(date: Date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000)
  return local.toISOString().slice(0, 16)
}
import { ArrowRight, Gauge, Sparkles } from 'lucide-react'
import { PageTitle, Panel } from '../components/Ui'

export function NewSimulation({ onCreate, onCancel }: { onCreate: (payload: Record<string, unknown>) => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState('Asami — Nuova vita')
  const [speed, setSpeed] = useState(60)
  const [description, setDescription] = useState('Persona simulata autonoma')
  const [firstName, setFirstName] = useState('Asami')
  const [lastName, setLastName] = useState('')
  const [start, setStart] = useState(() => localDateTimeValue(new Date()))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    setSaving(true); setError(null)
    try { await onCreate({ name, startedSimulationAt: new Date(start).toISOString(), asami: { name: firstName, firstName, lastName: lastName || null, description, speed } }) } catch (e) { setError(e instanceof Error ? e.message : 'Creazione non riuscita.') } finally { setSaving(false) }
  }
  return <div className="new-sim-wrap"><PageTitle eyebrow="FABBRICA DELLE SIMULAZIONI" title="Inizia una nuova vita" description="Questi valori vengono inviati direttamente al backend per creare la simulazione." action={<button className="ghost-button" onClick={onCancel}>Annulla</button>} /><div className="new-sim-grid"><Panel title="Identità della simulazione" eyebrow="CONFIGURAZIONE DEL MONDO"><div className="form-grid"><label>Nome simulazione<input aria-label="Nome simulazione" value={name} onChange={(e) => setName(e.target.value)} /></label><label>Inizio simulazione<input aria-label="Inizio simulazione" type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} /></label><label>Nome di Asami<input aria-label="Nome di Asami" value={firstName} onChange={(e) => setFirstName(e.target.value)} /></label><label>Cognome<input aria-label="Cognome" value={lastName} onChange={(e) => setLastName(e.target.value)} /></label><label className="wide">Descrizione<textarea aria-label="Descrizione" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} /></label></div></Panel><Panel title="Orologio" eyebrow="TEMPO SIMULATO"><div className="speed-selector"><div className="speed-icon"><Gauge size={18} /></div><div><strong>Velocità predefinita ×{speed}</strong><span>I secondi reali vengono convertiti in tempo simulato.</span></div><select aria-label="Velocità predefinita" value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>{[1, 2, 5, 10, 30, 60, 120, 300].map((x) => <option key={x} value={x}>×{x}</option>)}</select></div><div className="callout"><Sparkles size={16} /><span>L'orologio viene persistito nei segmenti del database: il frontend non simula il tempo localmente.</span></div><button className="primary-button wide-button" disabled={saving || !name.trim() || !firstName.trim()} onClick={() => void submit()}>{saving ? 'Creazione…' : <>Crea simulazione <ArrowRight size={16} /></>}</button>{error && <div className="composer-error">{error}</div>}</Panel></div></div>
}
