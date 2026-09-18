/**
 * livesociya — contrast check for the palette, both themes.
 *
 *   node test/contrast.mjs
 *
 * No browser, no network: it reads the token values straight out of
 * style.css and does the WCAG maths on them. Run it whenever a colour
 * token changes.
 *
 * Why it exists. The palette is a family of greens, which means every
 * pair is close together and it is genuinely easy to pick two that
 * look fine on a good laptop screen and are unreadable on a cheap
 * phone in daylight. Two real ones this caught:
 *
 *   - the LIVE chip's text was the same ember as the dot beside it,
 *     which is a fine FILL and a 3.3:1 ink. Hence --ember-ink.
 *   - the delete button's label came from --on-accent, which flips to
 *     a DARK ink in dark mode because it normally sits on pale moss —
 *     dark text on a red button, in the one dialog where misreading
 *     the button matters. Hence --on-danger.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const css = readFileSync(fileURLToPath(new URL('../style.css', import.meta.url)), 'utf8');

/** Pull one theme's `--name: #value` pairs out of a block of style.css. */
function tokens(startMarker) {
  const from = css.indexOf(startMarker);
  if (from === -1) throw new Error('block not found: ' + startMarker);
  const block = css.slice(from, css.indexOf('\n}', from));
  const out = {};
  for (const m of block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)) out[m[1]] = m[2];
  return out;
}

const THEMES = {
  light: tokens(':root {'),
  dark: tokens(':root[data-theme="dark"] {')
};

const hex = (h) => {
  h = h.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
};
const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const lum = (h) => { const [r, g, b] = hex(h); return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); };
const ratio = (a, b) => {
  const [hi, lo] = lum(a) > lum(b) ? [lum(a), lum(b)] : [lum(b), lum(a)];
  return (hi + 0.05) / (lo + 0.05);
};

// [what it is, foreground token, background token, minimum]
// 4.5 is AA for text. 3 is AA for a graphic that carries meaning on
// its own (a dot, a ring). 1.1 is "a hairline you can actually see".
const CHECKS = [
  ['body text on the page',      'ink',        'canvas',     4.5],
  ['body text on a card',        'ink',        'paper',      4.5],
  ['muted text on a card',       'fog',        'paper',      4.5],
  ['muted text on the page',     'fog',        'canvas',     4.5],
  ['muted text on a quiet fill', 'fog',        'bone',       4.5],
  ['label on the primary button','on-accent',  'forest',     4.5],
  ['label on an ink pill',       'on-ink-fill','ink',        4.5],
  ['a link or accent on a card', 'forest',     'paper',      4.5],
  ['ink on the marker wash',     'ink',        'fern',       4.5],
  ['ink on a soft fill',         'ink',        'wash',       4.5],
  ['the LIVE chip',              'ember-ink',  'ember-soft', 4.5],
  ['danger text on a card',      'rose-ink',   'paper',      4.5],
  ['label on a delete button',   'on-danger',  'danger-fill',4.5],
  ['toast text',                 'toast-ink',  'toast-bg',   4.5],
  ['a sage mark on a card',      'sage',       'paper',      3],
  ['the ember dot on the page',  'ember',      'canvas',     3],
  ['a hairline against the page','ash',        'canvas',     1.1],
  ['a hairline against a card',  'ash',        'paper',      1.15]
];

/**
 * The poster band is the one surface whose colour is COMPUTED rather
 * than declared: `color-mix(vibe BAND_MIX%, paper)`, once per vibe. So
 * it needs checking per vibe, in both themes — five more pairs each
 * that no static token list would cover, and the exact ones that break
 * if somebody adds a sixth category or dials the mix up.
 */
const BAND_MIX = (() => {
  // Not [^)]* — `var(--vibe, var(--sage))` nests a paren and that
  // stops at the wrong one. Take the first percentage after --band:.
  const m = css.match(/--band:[^;]*?(\d+)%/);
  return m ? Number(m[1]) / 100 : null;
})();

function mix(a, b, p) {
  const A = hex(a), B = hex(b);
  return '#' + [0, 1, 2].map((i) => Math.round(A[i] * p + B[i] * (1 - p)).toString(16).padStart(2, '0')).join('');
}

let failures = 0;
for (const theme of ['light', 'dark']) {
  console.log('\n' + theme);
  const t = THEMES[theme];
  for (const [name, fg, bg, min] of CHECKS) {
    if (!t[fg] || !t[bg]) { failures++; console.log('  ✗ missing token for ' + name + ' (' + fg + ' / ' + bg + ')'); continue; }
    const r = ratio(t[fg], t[bg]);
    if (r >= min) console.log('  ✓ ' + r.toFixed(2).padStart(5) + '  ' + name);
    else { failures++; console.log('  ✗ ' + r.toFixed(2).padStart(5) + '  ' + name + ' — needs ' + min + ' (' + t[fg] + ' on ' + t[bg] + ')'); }
  }
}
// ---- the poster band, per vibe ----
if (BAND_MIX === null) {
  failures++;
  console.log('\n✗ could not find the --band mix in style.css');
} else {
  for (const theme of ['light', 'dark']) {
    console.log('\n' + theme + ' — poster band at ' + Math.round(BAND_MIX * 100) + '% vibe');
    const t = THEMES[theme];
    for (const name of ['chill', 'food', 'party', 'study', 'sports']) {
      const vibe = t['vibe-' + name];
      if (!vibe) { failures++; console.log('  ✗ missing --vibe-' + name); continue; }
      const band = mix(vibe, t.paper, BAND_MIX);
      const r = ratio(t['chip-ink'], band);
      if (r >= 4.5) console.log('  ✓ ' + r.toFixed(2).padStart(5) + '  the band\'s text on ' + name);
      else { failures++; console.log('  ✗ ' + r.toFixed(2).padStart(5) + '  the band\'s text on ' + name + ' — needs 4.5 (' + t['chip-ink'] + ' on ' + band + ')'); }
    }
  }
}

console.log(failures ? '\n' + failures + ' failing' : '\nall good');
process.exit(failures ? 1 : 0);
