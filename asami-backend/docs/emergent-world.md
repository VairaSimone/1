# Emergent world

Asami now contains an additive emergent-world layer. The initial world remains deterministic, but inhabitants can create persistent world structures when multiple agents experience a shared pressure in the same location.

## Causal loop

`NEED -> SHARED PRESSURE -> PROPOSAL -> SUPPORTERS -> PROJECT -> WORLD STRUCTURE -> MACRO SYSTEM -> CONFLICT/POLICY`

Projects are created by an existing person entity. No player or API call is required.

## Current emergent project types

- `LOCAL_MARKET`: shared hunger pressure can produce a new market location with food, water and exchange activities.
- `COMMUNITY_HUB`: shared belonging/social pressure can produce a new community location.
- `WORKSHOP_COOPERATIVE`: shared achievement/curiosity pressure can produce a new workshop location.

Each proposal stores its generated name, activities, resource profile and emergence rationale.

## Macro systems

The maintenance pass can recognize:

- `ECONOMY`: persistent productive structures create an emergent exchange system.
- `GOVERNANCE`: population plus persistent structures or active conflicts create a civic coordination system and an organization entity.
- `SETTLEMENT`: population plus persistent structures create an emergent settlement. At larger thresholds it is classified as `TOWN` or `CITY`.

## Policies and conflicts

Once governance exists and an active conflict is present, the simulation can create multiple policy alternatives based on different personality profiles. Competing structures and competing policies are persisted as emergent conflicts.

## Persistence

The layer is persisted in:

- `emergent_projects`
- `emergent_project_members`
- `emergent_structures`
- `emergent_systems`
- `emergent_policies`
- `emergent_conflicts`

The world observer already reads `entities` + `locations`, so newly materialized locations appear in the normal world snapshot.

## API

`GET /api/simulations/:simulationId/emergence`

returns current projects, structures, macro systems, policies and conflicts.

## Important design constraint

Gemini is not allowed to mutate the world directly. The emergent layer remains deterministic and persisted in MySQL. A future cognitive extension can propose new project types or names, but every proposal must pass deterministic feasibility and persistence rules before the world changes.
