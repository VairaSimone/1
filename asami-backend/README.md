# Asami Backend

Backend Node.js per la simulazione autonoma di Asami. Il progetto usa **MySQL come source of truth** e non crea un secondo modello dati persistente in memoria.

## Cosa contiene

Il motore segue la catena:

`CLOCK -> WORLD -> PERCEPTION -> NEEDS -> EMOTION -> MEMORY -> GOALS -> DECISION -> ACTION -> EVENT -> EFFECT -> HISTORY -> LEARNING -> DEVELOPMENT`

Gemini viene usato come livello cognitivo opzionale: interviene sui casi realmente ambigui e nella conversazione, mentre la simulazione continua autonomamente con regole deterministiche quando Gemini non serve o non è disponibile.

## Requisiti

- Node.js 20+
- MySQL 8.0+
- API key Gemini solo se si vogliono le capacità cognitive generative

## Installazione

1. Importare il dump SQL nel database MySQL.
2. Copiare `.env.example` in `.env` e compilare almeno la configurazione MySQL.
3. Installare le dipendenze:

```bash
npm install
```

4. Avviare API + simulation worker:

```bash
npm start
```

Il server HTTP e il worker della simulazione partono nello stesso processo.

## Gemini e controllo costi

Il default è `gemini-3.6-flash` con un budget tecnico prudenziale:

```dotenv
GEMINI_ENABLED=true
GEMINI_MODEL=gemini-3.6-flash
GEMINI_DAILY_BUDGET_USD=0.35
GEMINI_MONTHLY_BUDGET_USD=10
GEMINI_DAILY_MAX_REQUESTS=100
GEMINI_MONTHLY_MAX_REQUESTS=2500
GEMINI_AUTONOMY_MIN_INTERVAL_MINUTES=10
```

Il backend crea automaticamente la tabella `gemini_usage` al primo avvio. Il consumo viene registrato con i token riportati dall'API Gemini, compresi i token di reasoning, e una richiesta viene bloccata prima dell'invio quando il budget giornaliero o mensile non è più disponibile.

Le decisioni autonome usano Gemini solo quando la scelta deterministica è debole o realmente ambigua. Le scelte evidenti restano interamente locali. Il sistema non riduce il set di azioni di Asami e non sostituisce il motore deterministico: Gemini serve a risolvere i casi che beneficiano maggiormente del ragionamento generativo.

Il consumo corrente è disponibile tramite:

`GET /api/gemini/usage`

Le risposte Gemini vengono richieste in JSON e validate con Zod. Il risultato dell'AI viene prima ridotto a una struttura interna sicura e solo dopo usato dalla logica deterministica.

## API principali

- `GET /api/health`
- `GET /api/gemini/usage`
- `GET /api/simulations`
- `GET /api/simulations/:simulationId`
- `POST /api/simulations`
- `POST /api/simulations/:simulationId/pause`
- `POST /api/simulations/:simulationId/resume`
- `POST /api/simulations/:simulationId/stop`
- `POST /api/simulations/:simulationId/speed`
- `GET /api/simulations/:simulationId/dashboard/:entityId`
- `GET /api/simulations/:simulationId/timeline`
- `GET /api/simulations/:simulationId/events`
- `GET /api/simulations/:simulationId/actions`
- `GET /api/simulations/:simulationId/memories/:entityId`
- `GET /api/simulations/:simulationId/relationships/:entityId`
- `GET /api/simulations/:simulationId/development/:entityId`
- `POST /api/simulations/:simulationId/conversations/messages`

WebSocket:

`ws://localhost:3000/realtime?simulationId=<uuid>`

Gli eventi includono `simulation.tick`, `world.event`, `entity.state`, `action.created`, `action.completed`, `message.created`, `simulation.status`.

## Nota sul database

Il dump contiene le tabelle necessarie alla simulazione. Il backend usa `UUID_TO_BIN()` / `BIN_TO_UUID()` per i PK `BINARY(16)` e filtra sempre per `simulation_id` quando lo schema lo prevede.

La sola struttura aggiunta automaticamente dal backend è `gemini_usage`, usata esclusivamente per il controllo di spesa e il conteggio dei token; non modifica le tabelle del modello di simulazione.

## Test

```bash
npm test
```
