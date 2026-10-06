"""Normalize real Parquet fields without repairing or inventing provider text."""
import json

def normalize_row(row):
    raw=row.get('abstract_inverted_index')
    if isinstance(raw,str):
        try:
            decoded=json.loads(raw)
            if decoded is not None:
                assert isinstance(decoded,dict)
                assert all(isinstance(positions,list) and all(isinstance(p,int) and not isinstance(p,bool) and p>=0 for p in positions) for positions in decoded.values())
            row['abstract_inverted_index']=decoded
        except (json.JSONDecodeError,AssertionError):
            # Some official snapshot strings are truncated JSON. Preserve the
            # exact field as evidence; display no reconstructed abstract.
            row['abstract_inverted_index_raw']=raw
            row['abstract_inverted_index']=None
            row['abstractUnavailableReason']='malformed-provider-index'
    row['publication_date']=str(row['publication_date']) if row.get('publication_date') else None
    return row
