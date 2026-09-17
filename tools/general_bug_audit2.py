from pathlib import Path

engine = Path('asami-backend/src/simulation/engine.js')
text = engine.read_text()
old = "UPDATE movements SET status='INTERRUPTED',actual_arrival_simulation_at=NULL,reason='autonomous route interrupted by critical state',version=version+1 WHERE id=UUID_TO_BIN(?) AND status='ACTIVE'`, [simulationTime, movementId]"
new = "UPDATE movements SET status='INTERRUPTED',actual_arrival_simulation_at=NULL,reason='autonomous route interrupted by critical state',version=version+1 WHERE id=UUID_TO_BIN(?) AND status='ACTIVE'`, [movementId]"
if old in text:
    text = text.replace(old, new, 1)
elif new not in text:
    raise SystemExit('movement interruption parameter mismatch not found')
engine.write_text(text)

test = Path('asami-backend/test/engine-helper.test.js')
text = test.read_text()
if 'interrupted movement update binds only movementId' not in text:
    text += '''\ntest("interrupted movement update binds only movementId",()=>{\n  const source=fs.readFileSync(path.join(__dirname,"../src/simulation/engine.js"),"utf8");\n  const start=source.indexOf("async function interruptActiveAction");\n  const end=source.indexOf("class SimulationEngine",start);\n  const section=source.slice(start,end);\n  assert.match(section,/UPDATE movements SET status='INTERRUPTED'.*WHERE id=UUID_TO_BIN\\(\\?\\).*status='ACTIVE'/);\n  assert.match(section,/status='ACTIVE'\\`, \\[movementId\\]\\)/);\n  assert.doesNotMatch(section,/status='ACTIVE'\\`, \\[simulationTime, movementId\\]\\)/);\n});\n'''
    test.write_text(text)
