# Asami Backend

Backend Node.js per la simulazione autonoma di Asami. Il progetto usa **MySQL come source of truth** e non crea un secondo modello dati persistente in memoria.

## Cosa contiene

Il motore segue la catena:

`CLOCK -> WORLD -> PERCEPTION -> NEEDS -> EMOTION -> MEMORY -> GOALS -> DECISION -> ACTION -> EVENT -> EFFECT -> HISTORY -> LEARNING -> DEVELOPMENT`

Gemini viene usato solo nei punti cognitivi dove serve generazione/interpretazione. Il motore continua a funzionare in fallback deterministico quando Gemini non è configurato o non è disponibile.

## Requisiti

- Node.js 20+
- MySQL 8.0+ (il dump allegato è stato generato da MySQL 8.0.40; il progetto non richiede alterazioni di schema)
- API key Gemini solo se si vogliono le capacità cognitive generative

## Installazione

1. Importare `Dump20260914.sql` nel database MySQL.
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

Per eseguire solo il worker:

```bash
npm run worker
```

## Gemini

Impostare:

```dotenv
GEMINI_ENABLED=true
GEMINI_API_KEY=...
GEMINI_MODEL=...
```

Le risposte Gemini vengono richieste in JSON e validate con Zod. Il risultato dell'AI viene prima ridotto a una struttura interna sicura e solo dopo usato dalla logica deterministica.

## API principali

- `GET /api/health`
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
- `POST /api/simulations/:simulationId/conversations`
- `POST /api/simulations/:simulationId/conversations/:conversationId/messages`

WebSocket:

`ws://localhost:3000/realtime?simulationId=<uuid>`

Gli eventi includono `simulation.tick`, `world.event`, `entity.state`, `action.created`, `action.completed`, `message.created`, `simulation.status`.

## Nota sul database

Il progetto **non esegue migrazioni che alterino lo schema**.

Il dump contiene le tabelle correnti e storiche già necessarie, inclusi:

- `simulations`, `simulation_clock_segments`, `simulation_ticks`, `simulation_snapshots`
- `entities`, `entity_locations_current`, `entity_location_history`
- `entity_needs_current`, `entity_need_history`
- `entity_emotions_current`, `entity_emotion_history`
- `entity_traits_current`, `entity_trait_history`
- `memories`, `memory_state_history`
- `goals`, `plans`, `plan_steps`, `intentions`
- `decisions`, `decision_options`, `decision_outcomes`
- `actions`, `activities`, `movements`
- `events`, `event_effects`, `event_causes`, `event_participants`
- `relationships`, `relationship_history`
- comunicazione, conoscenza, credenze, sviluppo e autonomia.

Il backend usa `UUID_TO_BIN()` / `BIN_TO_UUID()` per i PK `BINARY(16)` e filtra sempre per `simulation_id` quando lo schema lo prevede.

## Avvertenza progettuale

Lo schema è molto ricco ma non contiene un catalogo esplicito di "strategie comportamentali" o una colonna dedicata alla persona dell'utente. Il motore therefore usa le tabelle esistenti (`attributes`, traits, needs, preferences, goals, memories, routines, autonomy policies/triggers) e non inventa un'ulteriore tabella.

Per una simulazione multi-agente futura sarà opportuno alimentare il mondo con più `entities`; il motore tratta ogni entità ACTOR come potenziale agente autonomo, mentre le decisioni vengono effettivamente calcolate per gli attori abilitati all'autonomia.

## Test

```bash
npm test
```
