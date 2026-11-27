// The numbered acceptance criteria of a ticket, read from its captured spec text by code (never typed by an agent). Pure.
// A criterion line = a checkbox item (`- [ ] …`, `* [x] …`) anywhere, or a list item (`-`, `*`, `+`, `1.`) under a heading that names the acceptance criteria. Numbered 1.. in reading order.
const CHECKBOX = /^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]\s+(\S.*)$/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(\S.*)$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*)$/;
const AC_HEADING = /acceptance\s+criteri|critères?\s+d['’]acceptation/i;

/** The criterion lines of `specText` in reading order (markers stripped, trimmed); [] when the text has none or is absent. */
export function criteriaLines(specText: string | null | undefined): string[] {
  if (!specText) return [];
  const out: string[] = [];
  let inCriteria = false;
  for (const raw of specText.replace(/\r\n/g, '\n').split('\n')) {
    const h = HEADING.exec(raw);
    if (h) { inCriteria = AC_HEADING.test(h[1]); continue; }
    const m = CHECKBOX.exec(raw) ?? (inCriteria ? LIST_ITEM.exec(raw) : null);
    if (m && m[1].trim()) out.push(m[1].trim());
  }
  return out;
}

/** Does a quoted sentence overlap a criterion line (one contains the other, trimmed)? */
export const quotesCriterion = (sentence: string, criteria: string[]): boolean => {
  const s = sentence.replace(/\r\n/g, '\n').trim();
  return s !== '' && criteria.some((c) => c.includes(s) || s.includes(c));
};
