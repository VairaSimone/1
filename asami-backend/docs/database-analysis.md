# Database analysis

Fonte: `Dump20260914.sql` fornito per il progetto.

## Architettura dati rilevata

### Core della simulazione
- `simulations`: stato corrente globale + tempo simulato.
- `simulation_clock_segments`: segmenti di clock, con un solo segmento `ACTIVE`.
- `simulation_ticks`: audit dei tick.
- `simulation_operations`: chiavi idempotenti per operazioni applicative.
- `simulation_settings`: configurazione versionata nel tempo.
- `simulation_snapshots`: checkpoint serializzati dello stato osservabile.

### Stato corrente / storico
- Bisogni: `entity_needs_current` + `entity_need_history`.
- Emozioni: `entity_emotions_current` + `entity_emotion_history`.
- Tratti: `entity_traits_current` + `entity_trait_history`.
- Posizione: `entity_locations_current` + `entity_location_history`.
- Sviluppo: `entity_development` + `development_history`.
- Relazioni: `relationships` + `relationship_history`.
- Memoria: `memories` + `memory_state_history`.

### Decisione e comportamento
- `goals` / `goal_dependencies`
- `plans` / `plan_steps`
- `intentions`
- `decisions` / `decision_options` / `decision_outcomes`
- `actions`
- `activities` / `activity_participants`
- `movements`
- `habits` / `routines` / `routine_items`

### Eventi e causalità
- `events`
- `event_participants`
- `event_effects`
- `event_causes`

### Cognizione/sociale
- `knowledge_items`, `entity_knowledge`
- `beliefs`
- `preferences`
- `relationships`
- comunicazione tramite `conversations`, `conversation_participants`, `messages`, `communication_intents`, `communication_attempts`

### Definizioni
- `need_definitions`
- `emotion_definitions`
- `trait_definitions`
- `skill_definitions`
- `activity_types`
- `event_types`
- `relationship_types`
- `entity_types`
- `development_stages`
- `ai_models`

## Vincoli importanti

- PK e molte FK usano `BINARY(16)`.
- Le entità sono isolate dalla coppia `(simulation_id, id)` in numerose relazioni.
- Le righe current possiedono `version`; il backend aggiorna con optimistic locking.
- Molte tabelle hanno CHECK su intervalli `[0,1]`, stati e coerenza temporale.
- `relationships` ha unicità condizionata tramite `active_marker`, quindi viene impedito il doppio rapporto attivo dello stesso tipo.
- `simulation_clock_segments` ha un solo segmento attivo grazie a `active_marker`.

## Conseguenza architetturale

La memoria in-process del worker serve solo per:
- timer/event loop;
- lock locali di un processo;
- broadcast WebSocket;
- cache effimere di metadata.

Non contiene una copia autorevole dello stato della simulazione. Lo stato viene letto dal DB a ogni ciclo decisionale.
