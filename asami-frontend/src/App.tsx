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
import { Mind } from './pages/Mind'
import { NewSimulation } from './pages/NewSimulation'
import { useSimulation } from './hooks/useSimulation'

export type View = 'overview' | 'analysis' | 'timeline' | 'memory' | 'mind' | 'relationships' | 'development' | 'chat'

export default function App() {
  const sim = useSimulation()
  const [view, setView] = useState<View>('overview')
  const [newSimulation, setNewSimulation] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const title = useMemo(() => ({
    overview: ['SALA DI CONTROLLO', 'Asami in tempo reale', 'Osserva cosa sta vivendo, quale bisogno guida il suo comportamento e come la simulazione evolve.'],
    analysis: ['OSSERVABILITÀ', 'Analisi della simulazione', 'Esamina ciò che è successo in un intervallo preciso, misura l’attività e individua eventuali anomalie.'],
    timeline: ['OSSERVABILITÀ', 'Cronologia', 'Eventi e azioni ordinati per tempo simulato.'],
    memory: ['COGNIZIONE', 'Memoria', 'Esperienze persistenti che possono essere richiamate dal sistema cognitivo.'],
    mind: ['COGNIZIONE', 'Mente di Asami', 'Identità, valori, desideri, attenzione, conflitti, aspettative e narrativa autobiografica.'],
    relationships: ['SOCIALE', 'Relazioni', 'La struttura relazionale di Asami e come cambiano i punteggi sociali.'],
    development: ['CRESCITA', 'Sviluppo', 'Tratti, capacità e segnali longitudinali di sviluppo.'],
    chat: ['COMUNICAZIONE', 'Parla con Asami', 'Una superficie di comunicazione collegata al servizio di comunicazione del backend.'],
  } as Record<View, [string, string, string]>)[view], [view])

  const doControl = async (action: 'pause' | 'resume' | 'stop') => {
    try {
      await sim.control(action)
      setNotice(action === 'pause' ? 'Simulazione messa in pausa.' : action === 'resume' ? 'Simulazione ripresa.' : 'Simulazione fermata.')
    } catch (e) { setNotice(e instanceof Error ? e.message : 'Operazione non riuscita.') }
    window.setTimeout(() => setNotice(null), 2800)
  }

  if (newSimulation) return <div className="shell"><main className="main standalone"><NewSimulation onCreate={async (payload) => { await sim.createSimulation(payload); setNewSimulation(false); setView('overview') }} onCancel={() => setNewSimulation(false)} /></main></div>
  if (sim.loading && !sim.dashboard) return <div className="startup"><div className="startup-mark">✦</div><strong>ASAMI</strong><span>Connessione al motore di simulazione…</span><div className="startup-loader" /></div>

  return <div className={`shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
    <div className="desktop-collapse"><button className="collapse-button" onClick={() => setSidebarCollapsed((v) => !v)} title={sidebarCollapsed ? 'Apri barra laterale' : 'Chiudi barra laterale'}>{sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}</button></div>
    {!sidebarCollapsed && <Sidebar simulations={sim.simulations} simulation={sim.simulation} view={view} setView={setView} onSimulationChange={sim.setSimulationId} onNewSimulation={() => setNewSimulation(true)} />}
    <main className="main">
      <Topbar simulation={sim.simulation} clockSpeed={sim.clockSpeed} wsConnected={sim.wsConnected} refreshing={sim.refreshing} onPause={() => void doControl('pause')} onResume={() => void doControl('resume')} onStop={() => void doControl('stop')} onSpeed={(speed) => sim.changeSpeed(speed).catch((e) => setNotice(e instanceof Error ? e.message : 'Cambio velocità non riuscito.'))} onRefresh={() => void sim.refresh(true)} />
      {notice && <div className="toast"><CheckCircle2 size={15} />{notice}</div>}
      {sim.error && !sim.dashboard && <div className="content"><ErrorState text={sim.error} retry={() => void sim.refresh()} /></div>}
      {!sim.dashboard && sim.simulation && <div className="content"><LoadingState text="Caricamento dello stato di Asami…" /></div>}
      {sim.dashboard && sim.simulation && <div className="content">
        {view !== 'overview' && <PageTitle eyebrow={title[0]} title={title[1]} description={title[2]} action={<button className="ghost-button" onClick={() => void sim.refresh(true)}>Sincronizza</button>} />}
        {view === 'overview' && <Overview simulation={sim.simulation} dashboard={sim.dashboard} clockSpeed={sim.clockSpeed} />}
        {view === 'analysis' && <Analysis simulationId={sim.simulation.id} entityId={sim.asamiId || sim.dashboard.entity.id} currentSimulationAt={sim.simulation.currentSimulationAt} onRefresh={() => void sim.refresh(true)} />}
        {view === 'timeline' && <Timeline items={sim.timeline} events={sim.events} />}
        {view === 'memory' && <Memory memories={sim.memories} />}
        {view === 'mind' && <Mind simulationId={sim.simulation.id} entityId={sim.asamiId || sim.dashboard.entity.id} />}
        {view === 'relationships' && <Relationships relationships={sim.dashboard.relationships} />}
        {view === 'development' && <Development current={sim.development.current} history={sim.development.history} traits={sim.dashboard.traits} />}
        {view === 'chat' && <Chat messages={sim.messages} conversationState={sim.conversationState} asami={sim.dashboard.entity} senderId={sim.chatSenderId} onSenderId={sim.setChatSenderId} onSend={async (text) => { await sim.sendMessage(text) }} />}
      </div>}
      {!sim.simulation && !sim.error && <div className="empty-root"><CircleAlert size={24} /><h2>Nessuna simulazione selezionata</h2><p>Crea la prima vita autonoma per accedere alla sala di controllo.</p><button className="primary-button" onClick={() => setNewSimulation(true)}><Plus size={16} /> Crea simulazione</button></div>}
      <footer className="footer">ASAMI · SALA DI CONTROLLO · REST + WebSocket · stato gestito dal backend · nessuna simulazione lato client</footer>
    </main>
  </div>
}
