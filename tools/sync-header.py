#!/usr/bin/env python3
"""One header, every page.

The site is static HTML with no build step, so the shared header lives in
partials/ and this script writes it into every page that carries it:

  partials/header.html   the markup; {{WORDMARK}} and {{ACTIONS}} are filled in
  partials/header.css    the styles, written between the centurio-header markers
  assets/brand/centurio-wordmark-currentcolor.svg   inlined as the wordmark

Each page keeps its own header actions (the buttons on the right). Everything
else in the header is identical. The script also adds the strapline beside the
copyright line in the footer, and strips the header rules each page used to
write for itself. It is safe to run any number of times.

Run from the repo root after any change to a header, or after regenerating a
page:  python3 tools/sync-header.py
"""
import os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGES = ['index', 'join', '1on1', 'score', 'guide', 'about', 'nutrition', 'corporate',
         'partners', 'trainers', 'affiliates', 'terms', 'privacy']
CSS_START = '/* centurio-header:start */'
CSS_END = '/* centurio-header:end */'
STRAPLINE = '<span class="strapline">Evidence based mental fitness training</span>'

# Header rules pages used to write for themselves. Removed wherever the whole
# selector list matches one of these.
LEGACY = {'header', '.header-row', '.wordmark', '.wordmark a', 'header .eyebrow',
          'header.site-nav', '.site-nav .wrap', '.nav-tag', '.nav-actions', '.header',
          '.submark', '.headercopy-legacy'}


def read(p):
    with open(os.path.join(ROOT, p), encoding='utf-8') as f:
        return f.read()


def actions_of(header):
    """The page's own header actions, verbatim."""
    m = re.search(r'<div class="(?:header-actions|nav-actions)">', header)
    if m:
        depth, i = 1, m.end()
        for t in re.finditer(r'<div\b|</div>', header[i:]):
            depth += 1 if t.group(0) == '<div' else -1
            if depth == 0:
                return header[i:i + t.start()].strip('\n').rstrip()
        sys.exit('unbalanced header actions')
    # Pages whose only action was a bare Member Login link.
    links = re.findall(r'<a [^>]*class="member-login-btn"[^>]*>[\s\S]*?</a>', header)
    return '\n'.join('      ' + l for l in links)


def strip_legacy(css):
    def repl(m):
        raw = m.group(1)
        comments = ''.join(re.findall(r'/\*[\s\S]*?\*/', raw))
        sel = re.sub(r'/\*[\s\S]*?\*/', '', raw)
        parts = [p.strip() for p in sel.split(',')]
        norm = [' '.join(p.split()).lower() for p in parts]
        if not all(norm) or any(n.startswith('@') for n in norm):
            return m.group(0)
        hit = [n in LEGACY for n in norm]
        if not any(hit):
            return m.group(0)
        lead = raw[:len(raw) - len(raw.lstrip())]
        if all(hit):
            return lead + comments
        return lead + comments + ','.join(p for p, h in zip(parts, hit) if not h) + '{' + m.group(2) + '}'
    return re.sub(r'([^{}]+)\{([^{}]*)\}', repl, css)


def sync(page, header_tpl, header_css, wordmark):
    path = page + '.html'
    s = read(path)
    m = re.search(r'<header[\s\S]*?</header>', s)
    if not m:
        sys.exit(f'{path}: no header found')
    actions = actions_of(m.group(0))  # may be empty: nutrition carries none
    new_header = header_tpl.replace('{{WORDMARK}}', wordmark).replace('{{ACTIONS}}', actions)
    s = s[:m.start()] + new_header + s[m.end():]

    # Styles: strip legacy header rules from every style block, then write the
    # shared block into the first one.
    s = re.sub(r'[ \t]*' + re.escape(CSS_START) + r'[\s\S]*?' + re.escape(CSS_END) + r'\n?', '', s)
    def clean_style(sm):
        body = re.sub(r'\n[ \t]+(?=\n)', '\n', strip_legacy(sm.group(2)))
        body = re.sub(r'\n{3,}', '\n\n', body)
        return sm.group(1) + body + sm.group(3)
    s = re.sub(r'(<style[^>]*>)([\s\S]*?)(</style>)', clean_style, s)
    i = s.index('</style>')
    s = s[:i] + '  ' + CSS_START + '\n' + header_css.rstrip() + '\n  ' + CSS_END + '\n' + s[i:]

    # Footer: the strapline beside the copyright line.
    if 'class="strapline"' not in s:
        s, n = re.subn(r'<span>(&copy; 2026 Centurio Collective\. All rights reserved\.)</span>',
                       r'<span class="copy-line"><span>\1</span>' + STRAPLINE + '</span>', s, count=1)
        if n != 1:
            sys.exit(f'{path}: copyright line not found in footer')

    with open(os.path.join(ROOT, path), 'w', encoding='utf-8') as f:
        f.write(s)
    return path


def main():
    header_tpl = read('partials/header.html').rstrip('\n')
    header_css = read('partials/header.css')
    wordmark = read('assets/brand/centurio-wordmark-currentcolor.svg').strip()
    wordmark = '\n'.join('      ' + l for l in wordmark.split('\n'))
    for p in PAGES:
        print('synced', sync(p, header_tpl, header_css, wordmark))


if __name__ == '__main__':
    main()
