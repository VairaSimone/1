import { Bot, Send, UserRound, WandSparkles } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChatMessage, ConversationState, Entity } from '../types'
import { formatSimTime } from '../lib/format'
import { EmptyState, Panel } from '../components/Ui'

export function Chat({ messages, conversationState, asami, senderId, onSenderId, onSend }: { messages: ChatMessage[]; conversationState: ConversationState | null; asami: Entity; senderId: string; onSenderId: (id: string) => void; onSend: (text: string) => Promise<void> }) {
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages.length])

  const canSend = Boolean(senderId && draft.trim() && !sending)
  const hints = useMemo(() => ['Come stai?', 'Cosa stai facendo adesso?', 'Cosa ricordi di recente?', 'Perché la pensi così?'], [])

  const submit = async () => {
    if (!canSend) return
    setSending(true)
    setError(null)
    try { await onSend(draft.trim()); setDraft('') }
    catch (e) { setError(e instanceof Error ? e.message : 'Invio non riuscito.') }
    finally { setSending(false) }
  }

  return <Panel className="chat-panel">
    <div className="chat-header">
      <div className="chat-avatar"><WandSparkles size={21} /></div>
      <div>
        <div className="eyebrow">COMUNICAZIONE DIRETTA</div>
        <h2>Parla con {asami.displayName}</h2>
        <span>Stai parlando con Asami: la sua memoria, il suo stato, i suoi obiettivi, le sue relazioni e il suo modo di comunicare possono cambiare nel tempo.</span>
        {conversationState?.state.currentTopic && <span>Tema attuale: {conversationState.state.currentTopic.replaceAll('_', ' ').toLowerCase()}</span>}
      </div>
    </div>

    <div className="chat-body" ref={scrollRef}>
      {messages.length ? messages.map((m) => {
        const metadata = (m.metadata && typeof m.metadata === 'object' ? m.metadata : {}) as Record<string, unknown>
        const proactive = Boolean(metadata.proactive)
        return <div className={`message ${m.messageType === 'ASSISTANT' ? 'assistant' : 'user'}`} key={m.id}>
          <div className="message-icon">{m.messageType === 'ASSISTANT' ? <Bot size={15} /> : <UserRound size={15} />}</div>
          <div className="message-bubble">
            {proactive && <small className="message-origin">ASAMI TI HA SCRITTO PER PRIMA</small>}
            <p>{m.content}</p>
            <span>{formatSimTime(m.simulationAt)}</span>
          </div>
        </div>
      }) : <EmptyState icon={<Bot size={21} />} title="Conversazione vuota" text="Scrivi ad Asami quando hai configurato un mittente valido." />}
    </div>

    <div className="chat-composer">
      <div className="hint-row">{hints.map((h) => <button key={h} onClick={() => setDraft(h)}>{h}</button>)}</div>
      <div className="composer-row">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit() } }}
          placeholder="Scrivi qualcosa ad Asami…"
          aria-label="Messaggio"
          rows={2}
        />
        <button className="send-button" disabled={!canSend} onClick={() => void submit()}>
          {sending ? 'Invio…' : <><Send size={16} /> Invia</>}
        </button>
      </div>
      {error && <div className="composer-error">{error}</div>}
    </div>
  </Panel>
}
