"""Reconcile full source cursors against unique publisher DOI identities."""
import argparse
import json
import sqlite3
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

root = Path(__file__).resolve().parents[1]
stage = root / 'data/openalex-refresh/management'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--require-finished', action='store_true')
args = parser.parse_args()
db = sqlite3.connect(stage / 'harvest.sqlite')
db.execute('PRAGMA query_only=ON')
rows = list(db.execute('''SELECT s.source,s.status,s.total,s.received,s.pages,s.error,COUNT(v.doi)
    FROM crossref_streams s LEFT JOIN crossref_seen v ON s.source=v.source GROUP BY s.source'''))
states = Counter(row[1] for row in rows)
mismatches = [{'scopusSourceId': key, 'available': total, 'received': received, 'uniqueDois': unique}
              for key, status, total, received, pages, error, unique in rows
              if status == 'complete' and (unique != total or received < unique)]
gaps = [{'scopusSourceId': key, 'status': status, 'reason': error}
        for key, status, total, received, pages, error, unique in rows if status in ['error', 'unavailable']]
report = {'generatedAt': datetime.now(timezone.utc).isoformat(), 'sourceStatus': dict(states),
          'finished': not (states['pending'] or states['running']), 'reconciledCompletedSources': states['complete'] - len(mismatches),
          'mismatches': mismatches, 'gaps': gaps,
          'basis': 'Unique exact DOI identities received for each registered source versus Crossref cursor total-results. Endpoint gaps are not counted as completed imports.'}
db.close()
path = stage / 'crossref-full-audit.json'
temporary = path.with_suffix('.tmp')
temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
temporary.replace(path)
print(json.dumps({key: value for key, value in report.items() if key not in ['basis', 'gaps']}))
if mismatches or (args.require_finished and not report['finished']):
    raise SystemExit(1)
