/**
 * The bundled `orchestra-browser` skill (#399, spec #388 stories 29-40, 43-44): how an agent drives its workspace's Browser pane with
 * `orchestra browser <command>`. Installed into every worktree as `.claude/skills/orchestra-browser/SKILL.md` by `installHooks`
 * (src/main/workspaces.ts). Pure text + a lint that holds the text to the CLI's own allowlist (`planBrowserCommand`).
 *
 * Written with `String.raw` and `§` standing for a backtick (the sed regex below needs literal backslashes); `§§§` is a code fence.
 */
import { BROWSER_COMMANDS, planBrowserCommand } from './browser-cli.ts';

export const BROWSER_SKILL_NAME = 'orchestra-browser';

/** Heading of the section whose first bash block is the worked example the test suite runs verbatim. */
export const BROWSER_SKILL_EXAMPLE_HEADING = '## Several commands in one call';

export const BROWSER_SKILL = String.raw`---
name: orchestra-browser
description: Drive THIS workspace's embedded Browser pane from Bash with §orchestra browser <command>§ — open pages, read them as a compact snapshot with element refs, click / fill / type / press / wait, screenshots, tabs, console and network. Use it whenever a task needs a real browser (testing a web app you are building, reproducing a UI bug, filling a form, checking a deployed page); the human sees the same pane.
---

# Drive your Browser pane — §orchestra browser§

One command per call, run from Bash (also inside scripts and sub-agents). It acts on THIS workspace's Browser pane only — the one the human sees beside the chat — so what you open there is visible to them. A failure is a non-zero exit plus a message on stderr.

## The loop: open → snapshot → act → snapshot again

§§§bash
orchestra browser open http://localhost:3000/login   # always a full URL (see Gotchas)
orchestra browser snapshot -i                        # interactive elements, each with a ref
#   - textbox "Email" [required, ref=e3]
#   - button "Sign in" [ref=e5]
orchestra browser fill @e3 "me@example.com"          # …ref=e3] is addressed as @e3
orchestra browser click @e5
orchestra browser snapshot -i                        # the page changed → take fresh refs
§§§

- §open§ returns once the page's load event has fired (measured: a page with a slow image returns after the image), so a §snapshot§ right after it sees the loaded document. Content a script renders AFTER the load still needs a §wait§. A page that never finishes loading makes §open§ time out.
- A ref belongs to the snapshot that issued it. After a navigation or a tab switch an old ref fails with §browser_stale_ref: @e5 no longer resolves…§ — run §snapshot§ again and use the new refs; never retry the stale one. After a re-render the old ref may still resolve (by role and name) or may not: when the page changed under you, snapshot again.
- §snapshot -i§ lists interactive elements only (the cheapest); plain §snapshot§ also carries headings and text; §-c§ drops empty structure, §-s "<css>"§ scopes it to part of the page, §-d <n>§ limits the depth.
- Prefer refs to coordinates. When you must: §mouse move X Y§, §mouse down§, §mouse up§ (viewport pixels).

## Act on the page

| need | command |
|---|---|
| click, hover, focus | §click @e5§ · §dblclick @e5§ · §hover @e5§ · §focus @e5§ |
| set a field | §fill @e3 "text"§ replaces the content and fires §input§; §press Tab§ afterwards if the page listens for §change§ |
| type | §type @e3 "text"§ appends to that element · §keyboard type "text"§ types into whatever is focused (neither sends key events: use §press§ for those) |
| keys | §press Enter§ · §press Tab§ · §press Control+a§ |
| choose, tick, upload | §select @e7 "Label"§ · §check @e8§ · §uncheck @e8§ · §upload @e9 ./report.pdf§ |
| scroll | §scroll down 600§ · §scroll up 200§ · §scrollintoview @e12§ · inside a scrollable box: §scroll down 300 --selector "#panel"§ |
| wait | §wait "#result"§ (until a selector appears) · §wait --fn "document.querySelector('#x') !== null"§ · §wait --text "Welcome"§ · §wait 500§ (milliseconds) |
| read | §get text @e5§ · §get value @e3§ · §get url§ · §get title§ · §is visible @e5§ |
| run JS | §eval "document.title"§ prints the value as JSON; a promise is awaited; a thrown error is exit 1. The page keeps ONE global scope: a top-level §const x§ / §let x§ declared in two calls fails the second ("already been declared") — wrap multi-statement scripts in §(() => { … })()§ |
| dialogs | §dialog status§ · §dialog accept§ · §dialog dismiss§ (an open §confirm()§ blocks the page until you answer) |
| debug | §console§ (console.* output; it may lag on a hidden pane) · §network requests§ · §cookies get§ · §storage local get <key>§ — §errors§ prints blank lines instead of the message and an uncaught page error does not reach §console§: catch one yourself with §eval "window.addEventListener('error', e => (window.__err = e.message))"§, read §eval "window.__err"§ later |
| history | §back§ · §forward§ · §reload§ |

## Seeing the page

§§§bash
orchestra browser screenshot                    # writes a PNG under your scratch dir and prints its path
orchestra browser screenshot "$TMPDIR/page.png" # or choose the file
§§§

Then open the file with the **Read** tool — it shows images. JPEG: §screenshot out.jpg --screenshot-format jpeg --screenshot-quality 60§ (the extension alone does not change the format). §--annotate§ overlays numbered labels on the interactive elements.

## Several commands in one call

A multi-step flow costs one turn, not one per click. Use §set -e§ so it stops at the first failure, and look refs up inside the script instead of hard-coding them (§ref§ re-snapshots, so the ref is always fresh, and it FAILS when nothing matches — assign its result to a variable, as below, so §set -e§ sees that failure):

§§§bash
set -e
b() { orchestra browser "$@"; }
ref() { b snapshot -i | grep -m1 "$1" | sed -n 's/.*ref=\(e[0-9]*\).*/@\1/p' | grep .; }
b open "$URL"
email=$(ref 'textbox "Email')
b fill "$email" "me@example.com"
button=$(ref 'button "Sign in')
b click "$button"
b wait "#welcome"
b get text "#welcome"
§§§

Put §--json§ first (§orchestra browser --json snapshot -i§) for machine-readable output.

## Tabs

§tab list§ · §tab new [url]§ · §tab t2§ (switch; use the id §tab list§ printed) · §tab close t2§

- §tab list§ marks each tab §(yours)§ or §(the user's)§ — read it before closing anything.
- At most 8 tabs per workspace, the human's and yours together; a refused §tab new§ says so (exit 1).
- You may close only the tabs YOU opened. Closing one of the human's fails with §browser_tab_not_owner§ (exit 1) and the tab stays open — do not try again. A page the human's tab opened as a popup is the human's too.
- Acting on a tab that is not the active one brings it to the front, and the human sees a notice (with a button to go back). Refs do not survive a tab switch: re-snapshot.
- Tab ids are not stable across an app restart: run §tab list§ before using one.

## When the pane is not on screen

The human sees one workspace's pane at a time. For a workspace in the background, or with its pane closed: §open§, §snapshot§, §get§, §eval§, §scroll§, §scrollintoview§, §wait --fn§ / §wait --text§ / §wait <ms>§, §console§, §network§, §cookies§ and §storage§ keep working; §screenshot§, §click§, §dblclick§, §hover§, §mouse§, §press§, §fill§, §type§ and §keyboard type§ fail at once and do nothing — with "this workspace's Browser pane is not on screen", or (§click§) "Element … is outside the viewport". Do not answer that with §scrollintoview§ and a retry, and do not retry in a loop: wait for the pane to come back. §wait "<selector>"§ is the exception to avoid there: a hidden page has no width, so it times out (25 s by default) for any element without an intrinsic size — text blocks, divs, the body, an element that still has to appear — and returns only for inputs and buttons. Use §wait --fn§, §--text§ or §wait <ms>§ instead, or add §--timeout 3000§ (lifting the hidden-pane limits is tracked in #406). To set a field meanwhile, §fill§ is out; use §eval§ with the native setter plus the two events (what makes React / Vue controlled inputs take the value):

§§§bash
orchestra browser eval "(() => { const el = document.querySelector('#q'); Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set.call(el, 'x'); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })()"
§§§

## Focus

Your commands were not observed to move the human's keyboard focus (they are built not to; no instrument here could force a steal, so this is an observation, not a guarantee): they keep typing in the composer while you drive the pane. §open§ and §tab new§ reveal the pane for them; on a page that is already loaded, read-only commands (§snapshot§, §get§, §eval§) do not re-open a pane they closed. The very first command on a workspace builds its pane (a blank page) and opens it for the human.

## What you cannot do

- Sign in as the human. The pane starts signed out unless the human attached a browser profile to this workspace; you cannot attach, switch or create profiles — ask the human.
- Reach another browser or another workspace's pane: §connect§, §close§, §session§, §install§, §batch§, §plugin§, §profiles§ and the flags §--cdp§, §--session§, §--profile§, §--headed§ are refused ("not available" for a command, "not allowed" for a flag).
- Not yet available: §download§, §trace§, §record§, §profiler§, §clipboard§.

## Gotchas

- A URL without a scheme gets §https://§, so §localhost:3000§ fails with §ERR_SSL_PROTOCOL_ERROR§: write §http://localhost:3000§. §file:///abs/path.html§ works.
- A page that does not load is exit 1 with the network error (§ERR_CONNECTION_REFUSED§ = nothing is listening).
- Relative file paths (§screenshot x.png§, §upload @e9 f.pdf§) resolve against your current directory.
- The command comes first: §orchestra browser snapshot -i§, not §orchestra browser -i snapshot§ (only §--json§ may lead).
- An EMPTY ref (§click ""§, §fill "" x§ — e.g. a lookup that matched nothing) is not an error: it succeeds and does not do what you meant. Check a variable before using it.
- §orchestra help browser§ prints a short reference.
`.replaceAll('§', '`');

// ── lint: the skill may only document what the CLI accepts ───────────────────────────────────────────────────────────────────────

/** Split a shell-ish line into words: single/double quotes group, `$(…)` collapses to a ref placeholder. */
export function shellWords(line: string): string[] {
  const s = line.replace(/\$\((?:[^()'"]|'[^']*'|"[^"]*")*\)/g, '@e0');
  const out: string[] = [];
  let cur = '';
  let has = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else if (c === '#' && !cur && !has) {
      break;
    } else cur += c;
  }
  if (has || cur) out.push(cur);
  return out;
}

const CANNOT_HEADING = '## What you cannot do';

/**
 * Every `orchestra browser …` command the skill shows, split by what the skill CLAIMS about it: `allowed` (bash-block lines, `orchestra browser …` or the
 * `b …` helper, and every backticked span anywhere else that starts with a CLI command word) and `refused` (spans under "What you cannot do").
 */
export function documentedCommands(text: string): { allowed: string[][]; refused: string[][]; refusedFlags: string[] } {
  const allowed: string[][] = [];
  const refused: string[][] = [];
  const refusedFlags: string[] = [];
  let inBash = false;
  let section = '';
  for (const raw of text.split('\n')) {
    if (/^```bash\s*$/.test(raw)) { inBash = true; continue; }
    if (/^```\s*$/.test(raw)) { inBash = false; continue; }
    if (inBash) {
      const m = /^(?:orchestra browser|b)\s+(.*)$/.exec(raw.trim());
      if (m) allowed.push(shellWords(m[1]!));
      continue;
    }
    if (raw.startsWith('## ')) section = raw;
    const line = raw.replace(/\bnot `[^`]*`/g, ''); // a deliberately wrong example ("not `orchestra browser -i snapshot`")
    for (const span of line.matchAll(/`([^`]+)`/g)) {
      const words = shellWords(span[1]!.replace(/^orchestra browser\s+/, '').replace(/<[^>]*>/g, 'x').replace(/\[[^\]]*\]/g, 'x'));
      const w0 = words[0];
      if (!w0 || w0 === 'x') continue; // empty, or a `<placeholder>` standing for any command
      if (section === CANNOT_HEADING) {
        if (w0.startsWith('--')) refusedFlags.push(w0);
        else if (/^[a-z]+$/.test(w0)) refused.push(words);
      } else if (BROWSER_COMMANDS.has(w0) || /^orchestra browser /.test(span[1]!)) allowed.push(words);
    }
  }
  return { allowed, refused, refusedFlags };
}

/** Problems found in a skill text (empty = clean). */
export function lintBrowserSkill(text: string): string[] {
  const problems: string[] = [];
  const m = /^---\nname: ([^\n]+)\ndescription: ([^\n]+)\n---\n/.exec(text);
  if (!m) return ['frontmatter: expected --- / name: / description: (one line) / ---'];
  if (m[1] !== BROWSER_SKILL_NAME) problems.push(`frontmatter name is ${m[1]}, expected ${BROWSER_SKILL_NAME}`);
  if (m[2]!.length > 700) problems.push(`description is ${m[2]!.length} chars (it is loaded on every turn: keep it under 700)`);
  const { allowed, refused, refusedFlags } = documentedCommands(text);
  if (allowed.length < 40) problems.push(`only ${allowed.length} documented commands found: the extractor or the skill is broken`);
  for (const words of allowed) {
    const plan = planBrowserCommand(words);
    if (!plan.ok) problems.push(`documented as usable but refused by the CLI: orchestra browser ${words.join(' ')} → ${plan.error.split('\n')[0]}`);
  }
  if (refused.length < 5) problems.push(`only ${refused.length} refused commands listed under "What you cannot do"`);
  for (const words of refused) {
    if (planBrowserCommand(words).ok) problems.push(`documented as refused but the CLI accepts it: orchestra browser ${words.join(' ')}`);
  }
  for (const f of refusedFlags) {
    if (planBrowserCommand(['get', 'url', f]).ok) problems.push(`documented as refused but the CLI accepts the flag ${f}`);
  }
  return problems;
}
