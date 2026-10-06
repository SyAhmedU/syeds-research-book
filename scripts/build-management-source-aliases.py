"""Preserve publisher venue names whose source type is verified by registry ISSN."""
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

root = Path(__file__).resolve().parents[1]
data = root / 'data'
catalog = json.loads((data / 'management-journals.json').read_text(encoding='utf-8-sig'))
db = sqlite3.connect(data / 'openalex-refresh/management/harvest.sqlite')
db.execute('PRAGMA query_only=ON')
aliases = {}
conference_dois = set()
for source in catalog['sources']:
    if source['sourceType'] != 'conference-series' or source.get('quartile') not in ['Q1', 'Q2']:
        continue
    for doi, payload in db.execute('SELECT s.doi,e.payload FROM crossref_seen s JOIN crossref_evidence e ON e.doi=s.doi WHERE s.source=?', (source['scopusSourceId'],)):
        work = json.loads(payload)
        if work.get('type') not in ['journal-article', 'proceedings-article', 'book-chapter'] or not work.get('title'):
            continue
        if not set(value.replace('-', '') for value in work.get('ISSN', [])).intersection(source['issns']):
            continue
        conference_dois.add(doi)
        for name in work.get('container-title') or []:
            aliases[(name, source['scopusSourceId'])] = {'name': name, 'canonicalName': source['name'],
                'sourceType': source['sourceType'], 'scopusSourceId': source['scopusSourceId'],
                'evidenceDoi': doi, 'issns': work['ISSN']}
db.close()
document = {'generatedAt': datetime.now(timezone.utc).isoformat(),
            'basis': 'Publisher container-title and DOI matched by exact registered ISSN; source type comes from the official Scopus registry, not the Crossref work-type label.',
            'aliases': list(aliases.values()), 'conferenceDois': sorted(conference_dois)}
output = data / 'management/source-aliases.json'
output.write_text(json.dumps(document, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
path = data / 'management/manifest.json'
manifest = json.loads(path.read_text(encoding='utf-8'))
manifest['sourceAliases'] = 'source-aliases.json'
path.write_text(json.dumps(manifest, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
print(json.dumps({'verifiedPublisherAliases': len(aliases), 'verifiedConferenceDois': len(conference_dois)}))
