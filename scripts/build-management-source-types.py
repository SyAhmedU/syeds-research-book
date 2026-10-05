"""Preserve official Scopus source types and identifiers, including conferences."""
import hashlib
import json
import re
import unicodedata
from collections import Counter
from pathlib import Path

import openpyxl

ROOT = Path(__file__).resolve().parents[1]
raw = ROOT.parent / 'journal-timelines/data/raw/scopus_source_list_mar_2026.xlsx'
rankings = json.loads((ROOT / 'data/management-rankings.json').read_text(encoding='utf-8'))
normalize = lambda s: re.sub(r'\s+', ' ', unicodedata.normalize('NFKC', str(s)).strip()).casefold()
exported = {normalize(r['name']) for r in rankings['records']}
workbook = openpyxl.load_workbook(raw, read_only=True, data_only=True)
sources = []
for sheet_name, conference in [('Scopus Sources Mar. 2026', False), ('Serial Conf. Proc. with Profile', True)]:
    sheet = workbook[sheet_name]
    rows = sheet.iter_rows(values_only=True)
    headers = list(next(rows))
    for number, values in enumerate(rows, 2):
        row = dict(zip(headers, values))
        name = row.get('Source Title')
        if not name:
            continue
        codes = [c.strip() for c in str(row.get('All Science Journal Classification Codes (ASJC)') or '').split(';') if c.strip()]
        management = any(re.fullmatch(r'14\d\d', c) for c in codes)
        if not management and normalize(name) not in exported:
            continue
        raw_type = 'Conference Proceedings' if conference else row['Source Type']
        source_type = {'Journal': 'journal', 'Book Series': 'book-series', 'Trade Journal': 'trade-publication',
                       'Conference Proceedings': 'conference-series'}.get(raw_type)
        if not source_type:
            raise ValueError(f'Unsupported official source type: {raw_type}')
        issns = []
        for key in ('ISSN', 'EISSN'):
            if row.get(key):
                issn = re.sub(r'[^0-9X]', '', str(row[key]).upper())
                if len(issn) != 8:
                    raise ValueError(f'Invalid ISSN: {name} {row[key]}')
                if issn not in issns:
                    issns.append(issn)
        sources.append({'name': name, 'scopusSourceId': str(row['Sourcerecord ID']),
                        'sourceType': source_type, 'sourceTypeRaw': raw_type, 'issns': issns,
                        'asjc': codes, 'managementClassified': management,
                        'scopeBasis': 'ASJC 14xx' if management else 'user-export selection; no ASJC 14xx in registry',
                        'publisher': row.get('Publisher'), 'status': row.get('Active or Inactive'),
                        'coverageYears': row.get('Coverage'),
                        'registryEvidence': {'file': raw.name, 'sheet': sheet_name, 'row': number}})
workbook.close()
output = {'version': 1, 'registrySource': 'Elsevier Scopus Source List March 2026',
          'registrySha256': hashlib.sha256(raw.read_bytes()).hexdigest(),
          'sourceTypeBasis': 'Official Source Type column; conference-series from Serial Conf. Proc. with Profile sheet',
          'sources': sources, 'coverage': dict(Counter(s['sourceType'] for s in sources))}
target = ROOT / 'data/management-source-types.json'
target.write_text(json.dumps(output, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
print(json.dumps(output['coverage']))
