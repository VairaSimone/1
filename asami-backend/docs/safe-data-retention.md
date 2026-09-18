# Safe data retention

Asami keeps a strict separation between live cognitive state and operational history.

The retention worker is intentionally conservative.

It never deletes current state, memories, actions, events, decisions, needs/emotions history, goals, intentions, relationships, knowledge, preferences, beliefs, identity or skills.

It only does the following:

1. After the configured decision-context retention period, it replaces the large JSON decision context with a tiny archived marker. The decision row itself is preserved.
2. After the configured decision-options retention period, it removes only non-selected options belonging to terminal decisions. The selected option is always preserved.
3. After the configured cognitive-artifact retention period, it removes only resolved expectations, counterfactuals and resolved counterfactual worlds belonging to terminal decisions.

Safety properties:

- A decision must be terminal before any child artifact is removed.
- The selected decision option is never removed by the option cleaner.
- Resolved/open state is checked explicitly for expectations and counterfactual worlds.
- Retention windows have hard minimums to prevent accidental aggressive configuration.
- Cleanup runs in bounded batches.
- A MySQL advisory lock prevents concurrent cleanup for the same simulation.
- Errors are isolated and logged; retention failures never fail a simulation tick.
- Cleanup uses the current simulation timestamp for retention cutoffs.
- RETENTION_DRY_RUN=true disables destructive statements for validation.

Default windows:

- decision context: 2 simulated days
- non-selected decision options: 3 simulated days
- resolved cognitive artifacts: 30 simulated days
- check interval: 15 real minutes
- batch size: 500 rows
- maximum deletes per table per cycle: 2000

The first implementation deliberately leaves large history tables untouched because they are still consumed by analysis/API code. They can be handled in a later phase after introducing equivalent rollups.
