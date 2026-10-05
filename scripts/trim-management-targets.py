"""Apply the publisher's referenced-ID gate to an existing snapshot without retagging."""
import json
import sqlite3
from pathlib import Path

root=Path(__file__).resolve().parents[1]
db=sqlite3.connect(root/'data/openalex-refresh/management/harvest.sqlite')
referenced={row[0] for row in db.execute('SELECT DISTINCT cited FROM edges')}
before=after=0
for path in (root/'data/management/targets').glob('*.json'):
    before+=path.stat().st_size
    rows=json.loads(path.read_text(encoding='utf-8'))
    kept={key:value for key,value in rows.items() if key in referenced}
    assert all(rows[key]==value for key,value in kept.items())
    temporary=path.with_suffix('.tmp')
    temporary.write_text(json.dumps(kept,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
    temporary.replace(path)
    after+=path.stat().st_size
db.close()
print(json.dumps({'targetBytesBefore':before,'targetBytesAfter':after,'referencedIdentities':len(referenced)}))
