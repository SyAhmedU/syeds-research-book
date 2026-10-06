"""Read the committed management harvest status without changing its queue."""
import json
import sqlite3
from datetime import datetime
from pathlib import Path

stage = Path(__file__).resolve().parents[1] / 'data/openalex-refresh/management'
db = sqlite3.connect(stage / 'harvest.sqlite')
db.execute('PRAGMA query_only=ON')
states = dict(db.execute('SELECT status,COUNT(*) FROM crossref_streams GROUP BY status'))
records = db.execute("SELECT COUNT(*) FROM works WHERE id LIKE 'doi:%'").fetchone()[0]
db.close()
print(json.dumps({'time': datetime.now().strftime('%H:%M:%S'), 'sourceStatus': states,
                  'totalSources': sum(states.values()), 'crossrefRecords': records}))
errors = stage / 'crossref-full-run.err.log'
if errors.exists() and errors.stat().st_size:
    print(errors.read_text(encoding='utf-8')[-1000:])
