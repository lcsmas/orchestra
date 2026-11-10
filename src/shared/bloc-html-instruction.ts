import { BLOC_HTML_ENV } from './bloc-html-setting.ts';
import { BLOC_THEME_KEYS } from './bloc-html-document.ts';
import { BLOC_HTML_LABEL, BLOC_HTML_MAX_SOURCE_BYTES } from './reply-segments.ts';

// The text every workspace session is told when Bloc HTML is on (#418, spec #414 story 36). Pure: workspaces.ts wraps it in the
// SessionStart hook script, the unit test pins its clauses and its size. The fence label is frozen (ADR 0011).

/** Ceiling for the injected text: it is re-billed as input at every session start. */
export const BLOC_HTML_INSTRUCTION_MAX_CHARS = 1600;

/** The size cap told to the model, DERIVED from the reader's constant (#419 retunes it): the text cannot name a size the frame refuses. */
export const BLOC_HTML_MAX_SOURCE_KIB = Math.floor(BLOC_HTML_MAX_SOURCE_BYTES / 1024);

/** The theme custom properties a bloc's frame defines — derived from the frame builder's keys, so the text can never name a variable the frame lacks. */
export const BLOC_HTML_THEME_VARS = BLOC_THEME_KEYS.map((k) => `--bloc-${k}`);

export const BLOC_HTML_INSTRUCTION = [
  `[orchestra] Bloc HTML: your reply may contain HTML rendered in place in the Agent view, as a fenced block labelled \`${BLOC_HTML_LABEL}\`:`,
  `\`\`\`${BLOC_HTML_LABEL} title="Short title"`,
  '<div>…</div>',
  '```',
  `- Theme: the frame is transparent and already themed; colour with ${BLOC_HTML_THEME_VARS.map((v) => `var(${v})`).join(', ')} (no hard-coded page colours, no \`color-scheme\`). A quote in the title is written \\".`,
  `- Network: https: only. Scripts (libraries, charts), styles, fonts, images, fetch and wss: may load from https URLs, and the block then needs the network to render; plain http: is refused. Inline <style>/<script>, data: and blob: work offline. Past ${BLOC_HTML_MAX_SOURCE_KIB} KiB of source it is shown as code.`,
  '- Limits: No eval/new Function, no <iframe>/<video>/<audio>/forms; data: is for images, fonts and fetch only.',
  '- No state is kept (scripts restart when the block scrolls back into view) and it cannot talk to the conversation. Its height is its content: no 100vh.',
  '- Use it only where it beats prose: comparisons, figures and charts, diagrams, status boards. Ordinary answers stay markdown. A plain ```html fence stays a code sample.',
].join('\n');

/** The SessionStart hook script: prints the instruction only when the session's CLI carries ${ORCHESTRA_BLOC_HTML}=1 (frozen at its start — a flip never reaches a running session). */
export function blocHtmlInstructionScript(): string {
  return `#!/usr/bin/env bash
# Auto-installed by orchestra (#418). Tells the session the Bloc HTML surface exists, only when ${BLOC_HTML_ENV}=1 was set at its start.
[ "\${${BLOC_HTML_ENV}:-}" = "1" ] || exit 0
cat <<'ORCHESTRA_BLOC_HTML_EOF'
${BLOC_HTML_INSTRUCTION}
ORCHESTRA_BLOC_HTML_EOF
exit 0
`;
}
