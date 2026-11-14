#!/usr/bin/env node
// The brand rule on the marketing site: no hyphens, no en dashes and no em
// dashes anywhere a visitor reads. Same character class as assertNoDashes in
// the member portal (lib/email/template.ts): /[-–—]/.
//
// Why this exists (PROMPT_82): the earlier check was a throwaway script run
// over a hand picked list of pages, with every <script> block and every
// attribute stripped before checking. So it never saw:
//   1. pages left off the list (terms, privacy, nutrition, welcome-1on1),
//   2. copy written by JavaScript (nutrition's macro notes, form messages),
//   3. copy in attributes (placeholder, title, alt, aria-label, meta
//      descriptions and social cards).
// This one walks every .html file in the repo root and checks all three.
//
// Usage: node tools/check-dashes.mjs [file ...]   (defaults to every page)
// Exits 1 and lists every hit if anything fails.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DASH = /[-–—]/;
const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync(ROOT).filter((f) => f.endsWith('.html')).sort();

const decode = (s) => s.replace(/&nbsp;/g, ' ').replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')
  .replace(/&#8212;/g, '—').replace(/&#8211;/g, '–').replace(/&amp;/g, '&');
// A URL, an email address or a file name carries hyphens that nobody reads as copy.
const stripTechnical = (s) => s
  .replace(/\b(?:https?:\/\/|www\.)[^\s"'<>)]*/g, ' ')
  .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+/g, ' ')
  .replace(/\b[\w-]+\.(?:pdf|html|png|jpg|webp|svg|js|css)\b/g, ' ')
  // A licence's registered name is not ours to respell.
  .replace(/\bCC BY(?:-SA|-NC|-ND)*\b/g, ' ');

// Hyphenated words the owner has decided may stay (Sterling, 14 November 2026):
// standard legal usage on the Terms and Privacy pages. Only these exact words, only on
// these pages. A new hyphen anywhere else still fails.
const ALLOWED = {
  'terms.html': ['12-month', '14-Day', '14-day', '30-minute', 'first-ever', 'no-show', 'non-refundable', 'self-reported'],
  'privacy.html': ['dispute-resolution', 'early-stage', 'self-reported'],
};
const allow = (file, s) => (ALLOWED[file] || []).reduce((t, w) => t.split(w).join(' '), s);

let checked = 0;
const hits = [];
const test = (file, where, raw) => {
  const s = stripTechnical(decode(raw)).replace(/\s+/g, ' ').trim();
  if (!s) return;
  checked++;
  if (DASH.test(allow(file, s))) hits.push(`${file} [${where}] ${s.slice(0, 140)}`);
};

for (const file of files) {
  const html = readFileSync(join(ROOT, file), 'utf8');
  const noComments = html.replace(/<!--[\s\S]*?-->/g, '');

  // 1. Text a visitor reads, the <title> included. Styles and inline SVG
  //    artwork (path data) are not copy.
  const body = noComments
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<svg[\s\S]*?<\/svg>/g, (svg) => (svg.match(/<(?:title|text)[^>]*>[^<]*<\/(?:title|text)>/g) || []).join('\n'));
  for (const t of body.replace(/<[^>]+>/g, '\n').split('\n')) test(file, 'text', t);

  // 2. Attributes that are read or heard.
  for (const m of noComments.matchAll(/\s(alt|title|placeholder|aria-label|data-msg|value)="([^"]*)"/g)) {
    if (m[1] === 'value' && !/\s/.test(m[2])) continue; // form values like "lose-fat" are not copy
    test(file, m[1], m[2]);
  }
  for (const m of noComments.matchAll(/<meta\s+(?:name|property)="(description|og:title|og:description|og:image:alt|twitter:title|twitter:description)"\s+content="([^"]*)"/g)) {
    test(file, m[1], m[2]);
  }

  // 3. Copy written by JavaScript: string literals that read as prose
  //    (two or more words, no code punctuation).
  for (const sm of noComments.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
    const js = sm[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
    for (const lm of js.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) {
      let lit = (lm[1] ?? lm[2] ?? lm[3]).replace(/\$\{[^}]*\}/g, ' ');
      // En and em dashes are never code, so any string carrying one is checked.
      if (/[–—]/.test(lit)) { test(file, 'js', lit); continue; }
      if (!/[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(lit)) continue; // not prose
      if (/^[a-z][a-z0-9-]*(?:\s+[a-z][a-z0-9-]*)*$/.test(lit.trim()) && /-/.test(lit)) continue; // class names, e.g. 'form-msg err'
      if (/[{};=<>]|^\s*[.#][\w-]|\(\s*\)|\b(?:var|const|let|function|return)\b/.test(lit)) continue; // code or markup
      test(file, 'js', lit);
    }
  }
}

console.log(`check-dashes: ${checked} strings checked across ${files.length} pages`);
if (hits.length) {
  console.log(`${hits.length} dash(es) found:`);
  for (const h of hits) console.log('  ' + h);
  process.exit(1);
}
console.log('no dashes');
