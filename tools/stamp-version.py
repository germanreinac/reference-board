#!/usr/bin/env python3
"""Stamp a new version into index.html before publishing.

Browsers keep copies of the app's files for a while (GitHub Pages tells them to
reuse files for 10 minutes), which can mix old and new code after an update.
This script lists every code file in an "import map" inside index.html, each
with ?v=<a fingerprint of its contents> added. A file that changed gets a new
address, so the browser fetches it; files that didn't change (the big libraries,
most of the app) keep their address and are reused from the browser's own copy,
so updates download only what's new. It also stamps style.css the same way and
writes the version into src/version.js (shown on the home screen).

Run it from anywhere:  python3 tools/stamp-version.py
"""
import datetime, hashlib, json, pathlib, re

root = pathlib.Path(__file__).resolve().parent.parent
version = datetime.datetime.now(datetime.timezone.utc).strftime('%Y.%m.%d-%H%M')

(root / 'src' / 'version.js').write_text(
    '// Written by tools/stamp-version.py: the version of the app, shown on the home screen.\n'
    f"export const VERSION = '{version}';\n")

files = sorted(p for d in ('src', 'vendor') for p in (root / d).rglob('*') if p.suffix in ('.js', '.mjs'))
mark = lambda p: hashlib.sha1(p.read_bytes()).hexdigest()[:10]
imports = {f'./{p.relative_to(root).as_posix()}': f'./{p.relative_to(root).as_posix()}?v={mark(p)}' for p in files}
importmap = '<script type="importmap">\n' + json.dumps({'imports': imports}, indent=2) + '\n  </script>'

html = (root / 'index.html').read_text()
html = re.sub(r'<script type="importmap">.*?</script>', lambda m: importmap, html, flags=re.S) if 'type="importmap"' in html \
    else html.replace('<link rel="stylesheet"', importmap + '\n  <link rel="stylesheet"', 1)
html = re.sub(r'href="style\.css(\?v=[^"]*)?"', f'href="style.css?v={mark(root / "style.css")}"', html)
html = re.sub(r'src="src/main\.js(\?v=[^"]*)?"', f'src="src/main.js?v={mark(root / "src" / "main.js")}"', html)
(root / 'index.html').write_text(html)
print('stamped', version, 'with', len(imports), 'files')
