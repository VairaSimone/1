# Asami Frontend

Control room React/TypeScript per il backend Node.js di Asami.

Il frontend **non simula nulla localmente**: legge lo stato dal backend REST e usa WebSocket per aggiornamenti live. In caso di WebSocket non disponibile, il pannello continua a fare refresh dei dati quando riceve il fallback di rete.

## Stack

- React 19.3
- TypeScript 7
- Vite 8
- Lucide React per le icone
- Fetch API nativa

Le versioni React/Vite/TypeScript/Lucide sono fissate nel `package.json` per rendere le installazioni ripetibili.

## Requisiti

Node.js 20.19+ or 22.12+ (Node 22 consigliato).

## Installazione

```bash
npm install
cp .env.example .env
npm run dev
```

Il dev server parte normalmente su `http://localhost:5173` e inoltra `/api` e `/realtime` al backend `http://localhost:3000`.

## Produzione

La build Docker usa Nginx e protegge il frontend con HTTP Basic Authentication. La password viene letta **solo a runtime** tramite `ASAMI_FRONTEND_PASSWORD`: non usare `VITE_ASAMI_FRONTEND_PASSWORD`, perché le variabili `VITE_*` finiscono nel bundle client.

Con il compose di esempio:

```bash
export ASAMI_FRONTEND_PASSWORD='la-tua-password'
docker compose up -d --build
```

Il browser mostrerà la richiesta di username e password quando accedi al frontend. Lo username predefinito è `asami`.

```bash
npm run build
npm run preview
```

La cartella `dist/` generata da `npm run build` è statica e, senza Nginx o un altro reverse proxy con autenticazione, non include questa protezione.

## Variabili ambiente

```dotenv
VITE_API_BASE_URL=http://localhost:3000/api
VITE_WS_BASE_URL=ws://localhost:3000/realtime
VITE_API_TARGET=http://localhost:3000
VITE_WS_TARGET=ws://localhost:3000
```

In produzione usare HTTPS + WSS, ad esempio:

```dotenv
VITE_API_BASE_URL=https://api.example.com/api
VITE_WS_BASE_URL=wss://api.example.com/realtime
```

## Integrazione con Asami backend

Il frontend usa le API realmente presenti nel backend fornito:

- `/api/health`
- `/api/simulations`
- `/api/simulations/:id`
- `/api/simulations/:id/clock`
- `/api/simulations/:id/pause`
- `/api/simulations/:id/resume`
- `/api/simulations/:id/stop`
- `/api/simulations/:id/speed`
- `/api/simulations/:id/asami`
- `/api/simulations/:id/dashboard/:entityId`
- `/api/simulations/:id/timeline`
- `/api/simulations/:id/events`
- `/api/simulations/:id/memories/:entityId`
- `/api/simulations/:id/relationships/:entityId`
- `/api/simulations/:id/development/:entityId`
- `/api/simulations/:id/conversations/:conversationId/messages`
- `/api/simulations/:id/conversations/messages`

WebSocket:

```text
ws://localhost:3000/realtime?simulationId=<uuid>
```

Gli eventi `simulation.tick`, `simulation.status`, `simulation.speed`, `world.event`, `entity.state`, `action.created`, `action.completed` e `message.created` fanno scattare aggiornamenti della UI.

## Chat: limite attuale del backend

Il backend corrente per `POST /conversations/messages` richiede `senderEntityId` e controlla che esista una seconda entità diversa da Asami. La creazione di una simulazione crea automaticamente Asami, ma **non crea né espone oggi un endpoint per un osservatore umano**.

Per questo la UI mostra un campo `Sender entity ID`. La chat funziona senza modifiche frontend quando il database contiene già una seconda entità valida della stessa simulazione e se ne inserisce l'UUID.

Non ho inventato un endpoint o una tabella per aggirare questo vincolo dello schema/backend.

## Struttura

```text
src/
  components/     UI condivisa e chrome dell'app
  hooks/          stato della simulazione + WebSocket
  lib/            API client + formatter
  pages/          viste della control room
  App.tsx
  main.tsx
  styles.css
```
