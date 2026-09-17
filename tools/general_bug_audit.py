from pathlib import Path

engine = Path('asami-backend/src/simulation/engine.js')
text = engine.read_text()
old_sql = "UPDATE actions SET status='COMPLETED',completed_simulation_at=?,result=? WHERE id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND simulation_id=UUID_TO_BIN(?) AND status='ACTIVE'"
new_sql = "UPDATE actions SET status='INTERRUPTED',completed_simulation_at=?,result=? WHERE id=UUID_TO_BIN(?) AND entity_id=UUID_TO_BIN(?) AND simulation_id=UUID_TO_BIN(?) AND status='ACTIVE'"
if old_sql in text:
    text = text.replace(old_sql, new_sql, 1)
elif new_sql not in text:
    raise SystemExit('expected interruption UPDATE was not found')
old_publish = 'action: { ...active, status: "COMPLETED", interrupted: true }'
new_publish = 'action: { ...active, status: "INTERRUPTED", interrupted: true }'
if old_publish in text:
    text = text.replace(old_publish, new_publish, 1)
elif new_publish not in text:
    raise SystemExit('expected interruption publish payload was not found')
engine.write_text(text)

repo = Path('asami-backend/src/repositories/simulation-repo.js')
text = repo.read_text()
marker = "async function updateCurrentTimeOptimistic(id, nowSimulation, version) {"
helper_start = "async function advanceAndCreateTick(id, nowSimulation, version, tickType, engineVersion) {"
if helper_start not in text:
    if marker not in text:
        raise SystemExit('simulation repo insertion marker missing')
    helper = '''async function advanceAndCreateTick(id, nowSimulation, version, tickType, engineVersion) {\n  return withTransaction(async conn => {\n    const [rows] = await conn.query(`\n      SELECT status,version\n      FROM simulations\n      WHERE id=UUID_TO_BIN(?)\n      LIMIT 1\n      FOR UPDATE\n    `, [id]);\n    if (!rows.length || rows[0].status !== "RUNNING" || Number(rows[0].version) !== Number(version)) return null;\n\n    const [updated] = await conn.query(`\n      UPDATE simulations\n      SET current_simulation_at=?, version=version+1\n      WHERE id=UUID_TO_BIN(?) AND version=? AND status='RUNNING'\n    `, [nowSimulation, id, version]);\n    if (updated.affectedRows !== 1) return null;\n\n    const tickId = uuid();\n    await conn.query(`\n      INSERT INTO simulation_ticks\n        (id,simulation_id,simulation_time,real_started_at,tick_type,status,engine_version)\n      VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),?,UTC_TIMESTAMP(3),?,'RUNNING',?)\n    `, [tickId, id, nowSimulation, tickType, engineVersion]);\n\n    return tickId;\n  });\n}\n\n'''
    text = text.replace(marker, helper + marker, 1)
old_exports = "  getActiveClock, updateCurrentTimeOptimistic, createTick, finishTick,"
new_exports = "  getActiveClock, updateCurrentTimeOptimistic, advanceAndCreateTick, createTick, finishTick,"
if old_exports in text:
    text = text.replace(old_exports, new_exports, 1)
elif new_exports not in text:
    raise SystemExit('simulation repo export marker missing')
repo.write_text(text)

engine = Path('asami-backend/src/simulation/engine.js')
text = engine.read_text()
old_sequence = '''const advanced = await simRepo.updateCurrentTimeOptimistic(sim.id, nextTime, sim.version); if (!advanced) return;\n      context.simulationTime = nextTime.toISOString(); phase = "tick.create"; tickId = await simRepo.createTick(sim.id, nextTime, "AUTONOMOUS", env.ENGINE_VERSION);'''
new_sequence = '''tickId = await simRepo.advanceAndCreateTick(sim.id, nextTime, sim.version, "AUTONOMOUS", env.ENGINE_VERSION); if (!tickId) return;\n      context.simulationTime = nextTime.toISOString(); phase = "tick.create";'''
if old_sequence in text:
    text = text.replace(old_sequence, new_sequence, 1)
if 'simRepo.advanceAndCreateTick(sim.id, nextTime, sim.version' not in text:
    raise SystemExit('engine clock/tick atomic sequence was not found')
engine.write_text(text)

test = Path('asami-backend/test/engine-helper.test.js')
text = test.read_text()
if 'interrupted actions are persisted and published as INTERRUPTED' not in text:
    text += '''\nconst fs=require("node:fs");\nconst path=require("node:path");\ntest("interrupted actions are persisted and published as INTERRUPTED",()=>{\n  const source=fs.readFileSync(path.join(__dirname,"../src/simulation/engine.js"),"utf8");\n  const start=source.indexOf("async function interruptActiveAction");\n  const end=source.indexOf("class SimulationEngine",start);\n  assert.ok(start>=0&&end>start);\n  const section=source.slice(start,end);\n  assert.match(section,/UPDATE actions SET status='INTERRUPTED'/);\n  assert.doesNotMatch(section,/UPDATE actions SET status='COMPLETED'/);\n  assert.match(source,/action: \{ \.\.\.active, status: "INTERRUPTED", interrupted: true \}/);\n});\n'''
if 'simulation clock and tick creation share one transaction' not in text:
    text += '''\ntest("simulation clock and tick creation share one transaction",()=>{\n  const source=fs.readFileSync(path.join(__dirname,"../src/repositories/simulation-repo.js"),"utf8");\n  const start=source.indexOf("async function advanceAndCreateTick");\n  const end=source.indexOf("async function updateCurrentTimeOptimistic",start);\n  assert.ok(start>=0&&end>start);\n  const section=source.slice(start,end);\n  assert.match(section,/return withTransaction\(async conn =>/);\n  assert.match(section,/UPDATE simulations/);\n  assert.match(section,/INSERT INTO simulation_ticks/);\n});\n'''
test.write_text(text)
