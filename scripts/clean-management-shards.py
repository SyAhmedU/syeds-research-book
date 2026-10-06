"""Remove obsolete generated shards after publishing a new management manifest."""
import json
import re
from pathlib import Path

output = (Path(__file__).resolve().parents[1] / 'data/management').resolve()
manifest = json.loads((output / 'manifest.json').read_text(encoding='utf-8'))
wanted = {entry['path'] for entry in manifest['files']}
suffix = '.json.gz' if manifest.get('compression') == 'gzip' else '.json'
removed = size = 0
for folder in ['index', 'abstracts', 'references', 'targets']:
    for path in (output / folder).iterdir():
        if not path.is_file():
            continue
        generated = (re.fullmatch(r'(?:journal|conference-series|book-series|trade-journal|unclassified)-\d{4}\.json(?:\.gz)?', path.name)
                     if folder == 'index' else re.fullmatch(r'(?:[0-5]\d|6[0-3])\.json(?:\.gz)?', path.name))
        if not generated:
            continue
        relative = path.relative_to(output).as_posix()
        keep = relative in wanted if folder == 'index' else path.name.endswith(suffix)
        if keep:
            continue
        # Resolve and check each file before deleting; never follow links outside this output directory.
        path.resolve().relative_to(output)
        size += path.stat().st_size
        path.unlink()
        removed += 1
print(json.dumps({'removedGeneratedShards': removed, 'removedBytes': size}))
