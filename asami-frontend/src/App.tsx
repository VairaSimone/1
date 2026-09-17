import { useMemo, useState } from 'react'
import { CheckCircle2, CircleAlert, PanelLeftClose, PanelLeftOpen, Plus } from 'lucide-react'
import { Sidebar } from './components/Sidebar'
import { Topbar } from './components/Topbar'
import { ErrorState, LoadingState, PageTitle } from './components/Ui'
import { Overview } from './pages/Overview'
import { Analysis } from './pages/Analysis'
import { Timeline } from './pages/Timeline'
import { Memory } from './pages/Memory'
import { Relationships } from './pages/Relationships'
import { Development } from './pages/Development'
import { Chat } from './pages/Chat'
import { NewSimulation } from './pages/NewSimulation'
import { useSimulation } from './hooks/useSimulation'

export type View = 'overview' | 'analysis' | 'timeline' | 'memory' | 'relationships' | 'development' | 'chat'

export default function App() {
  const sim = useSimulation()
  const [view, setView] = useState<View>('overview')
  const [newSimulation, setNewSimulation] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const title = useMemo(() => ({
    overview: ['CONTROL ROOM', 'Asami, in real time', 'Osserva cosa sta vivendo, quale bisogno guida il suo comportamento e come la simulazione evolve.'],
    analysis: ['OBSERVABILITY', 'Simulation analysis', 'Leggi cosa è successo in un intervallo preciso, misura l’attività e lascia che i controlli evidenzino dati sospetti.'],
    timeline: ['OBSERVABILITY', 'Timeline', 'Eventi e azioni ordinati per tempo simulato.'],
    memory: ['COGNITION', 'Memory', 'Esperienze persistenti che possono essere richiamate dal sistema cognitivo.'],
    relationships: ['SOCIAL', 'Relationships', 'La struttura relazionale di Asami e come cambiano i punteggi sociali.'],
    development: ['GROWTH', 'Development', 'Tratti, capacità e segnali longitudinali di sviluppo.'],
    chat: ['COMMUNICATION', 'Talk to Asami', 'Una superficie di comunicazione collegata al communication service del backend.'],
  } as Record<View, [string, string, string]>)[view], [view])

  const doControl = async (action: 'pause' | 'resume' | 'stop') => {
    try { await sim.control(action); setNotice(action === 'pause' ? 'Simulation paused.' : action === 'resume' ? 'Simulation resumed.' : 'Simulation stopped.') } catch (e) { setNotice(e instanceof Error ? e.message : 'Operation failed.') }
    window.setTimeout(() => setNotice(null), 2800)
  }

  if (newSimulation) return <div className="shell"><main className="main standalone"><NewSimulation onCreate={async (payload) => { await sim.createSimulation(payload); setNewSimulation(false); setView('overview') }} onCancel={() => setNewSimulation(false)} /></main></div>
  if (sim.loading && !sim.dashboard) return <div className="startup"><div className="startup-mark">✦</div><strong>ASAMI</strong><span>Connecting to simulation engine…</span><div className="startup-loader" /></div>

  return <div className={`shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
    <div className="desktop-collapse"><button className="collapse-button" onClick={() => setSidebarCollapsed((v) => !v)} title="Toggle sidebar">{sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}</button></div>
    {!sidebarCollapsed && <Sidebar simulations={sim.simulations} simulation={sim.simulation} view={view} setView={setView} onSimulationChange={sim.setSimulationId} onNewSimulation={() => setNewSimulation(true)} />}
    <main className="main">
      <Topbar simulation={sim.simulation} clockSpeed={sim.clockSpeed} wsConnected={sim.wsConnected} refreshing={sim.refreshing} onPause={() => void doControl('pause')} onResume={() => void doControl('resume')} onStop={() => void doControl('stop')} onSpeed={(speed) => sim.changeSpeed(speed).catch((e) => setNotice(e instanceof Error ? e.message : 'Speed change failed'))} onRefresh={() => void sim.refresh(true)} />
      {notice && <div className="toast"><CheckCircle2 size={15} />{notice}</div>}
      {sim.error && !sim.dashboard && <div className="content"><ErrorState text={sim.error} retry={() => void sim.refresh()} /></div>}
      {!sim.dashboard && sim.simulation && <div className="content"><LoadingState text="Loading Asami state…" /></div>}
      {sim.dashboard && sim.simulation && <div className="content">
        {view !== 'overview' && <PageTitle eyebrow={title[0]} title={title[1]} description={title[2]} action={<button className="ghost-button" onClick={() => void sim.refresh(true)}>Sync now</button>} />}
        {view === 'overview' && <Overview simulation={sim.simulation} dashboard={sim.dashboard} />}
        {view === 'analysis' && <Analysis simulationId={sim.simulation.id} entityId={sim.asamiId || sim.dashboard.entity.id} currentSimulationAt={sim.simulation.currentSimulationAt} onRefresh={() => void sim.refresh(true)} />}
        {view === 'timeline' && <Timeline items={sim.timeline} events={sim.events} />}
        {view === 'memory' && <Memory memories={sim.memories} />}
        {view === 'relationships' && <Relationships relationships={sim.dashboard.relationships} />}
        {view === 'development' && <Development current={sim.development.current} history={sim.development.history} traits={sim.dashboard.traits} />}
        {view === 'chat' && <Chat messages={sim.messages} asami={sim.dashboard.entity} senderId={sim.chatSenderId} onSenderId={sim.setChatSenderId} onSend={async (text) => { await sim.sendMessage(text) }} />}
      </div>}
      {!sim.simulation && !sim.error && <div className="empty-root"><CircleAlert size={24} /><h2>Nessuna simulazione selezionata</h2><p>Crea la prima vita autonoma per accedere alla control room.</p><button className="primary-button" onClick={() => setNewSimulation(true)}><Plus size={16} /> Create simulation</button></div>}
      <footer className="footer">ASAMI CONTROL ROOM · REST + WebSocket · backend-driven state · no client-side simulation</footer>
    </main>
  </div>
}
