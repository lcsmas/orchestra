// Role guard write-target scanner (#475). POSIX awk run by role-guard.sh on the decoded Bash command: a small quote-aware shell reader
// that finds the files a command WRITES (`>` `>>` `>|` `&>` redirects, `tee`, `sed -i`) and prints each one that does NOT resolve into
// the role's scratch as `W<TAB>target` / `SEDI<TAB>target`. Quoted text is DATA unless the command is a wrapper that executes it
// (`bash|sh|zsh|dash|ksh -c`, `eval`, `ssh host`, `$( )`, backticks, `<( )`). Resolved: `VAR` / `${VAR}` / `~` / `..` / relative-to-cwd
// (the payload cwd, moved by `cd` in the same command, scoped by subshells). Anything unresolvable is NOT scratch (fail closed).
// No backtick and no `${` in here: this text lives in a String.raw template.

export const AWK_WRITES = String.raw`
function ws(c) { return c == " " || c == "\t" || c == "\r" }
function isop(c) { return c == ";" || c == "&" || c == "|" || c == "(" || c == ")" || c == "<" || c == ">" }
function emit(kind, disp) { if (!quiet) print kind "\t" disp }
function norm(p,   n, a, i, k, r, out) {
  n = split(p, a, "/"); k = 0
  for (i = 1; i <= n; i++) {
    if (a[i] == "" || a[i] == ".") continue
    if (a[i] == "..") { if (k > 0) k--; continue }
    k++; r[k] = a[i]
  }
  out = ""
  for (i = 1; i <= k; i++) out = out "/" r[i]
  return (out == "") ? "/" : out
}
function absp(t) {
  if (substr(t, 1, 1) == "/") return norm(t)
  if (cwd == "") return ""
  return norm(cwd "/" t)
}
function under(p, root) { return root != "" && index(p, root "/") == 1 }
function scratch(p,   rest) {
  if (p == "") return 0
  if (p == "/dev/null" || p == "/dev/stderr" || p == "/dev/stdout" || p == "/dev/tty" || index(p, "/dev/fd/") == 1) return 1
  if (under(p, "/tmp") || under(p, "/var/tmp")) return 1
  if (HOMEV != "" && (under(p, HOMEV "/.orchestra/agent-tmp") || under(p, HOMEV "/.orchestra-dev/agent-tmp"))) return 1
  if (OHOME != "" && under(p, OHOME "/agent-tmp")) return 1
  if (TMPD != "" && under(p, TMPD)) return 1
  if (HOMEV != "" && index(p, HOMEV "/.claude") == 1) {
    rest = substr(p, length(HOMEV "/.claude") + 1)
    if (rest ~ "^[^/]*/projects/[^/]+/memory/") return 1
  }
  return 0
}
function san(v) { return (v ~ "[ \t{};]" || (ifs && !safetok(v))) ? UNRES : v }
function jlog(nm) {
  # remember nm before a mutation so the enclosing scope can undo it (O(changes), not O(variables) per scope)
  if (sd == 0) return
  jn++; JN[jn] = nm; JH[jn] = (nm in vals)
  if (JH[jn]) { JV[jn] = vals[nm]; JP[jn] = vpoison[nm] }
}
function poisonvar(nm) {
  jlog(nm)
  vals[nm] = UNRES; vpoison[nm] = 1
}
function poison_all(   n) {
  for (n in vals) { jlog(n); vals[n] = UNRES; vpoison[n] = 1 }
  envpoison = 1; cwd = ""
}
function getvar(nm) {
  if (nm in vals) return (vpoison[nm]) ? UNRES : vals[nm]
  if (envpoison) return UNRES
  if (nm == "RANDOM") return "12345"
  if (nm == "PWD") return (cwd == "") ? UNRES : cwd
  if ((nm in ENVIRON) && ENVIRON[nm] != "") return ENVIRON[nm]
  if (nm == "TMPDIR") return "/tmp/.TMPDIR"
  return UNRES
}
function okpath(v) { return index(v, UNRES) == 0 && scratch(absp(v)) }
function safetok(v) { return (index(v, UNRES) == 0 && v ~ "^[A-Za-z0-9_][A-Za-z0-9_.-]*$" && v != "..") }
function setvar(nm, v) {
  # reassigning one single-component token to another cannot change where a path lands, so it is not a hazard
  jlog(nm)
  if ((nm in vals) && !(safetok(vals[nm]) && safetok(v)) && !(okpath(vals[nm]) && okpath(v))) vpoison[nm] = 1
  vals[nm] = v
}
function judge(kind, disp, v, br,   p, praw) {
  if (br || index(v, UNRES)) { emit(kind, disp); return }
  if (v ~ "[*?[]" && v ~ "(^|/)[.][.](/|$)") { emit(kind, disp); return }
  p = absp(v)
  if (!scratch(p)) { emit(kind, disp); return }
  praw = (substr(v, 1, 1) == "/") ? v : cwd "/" v
  if (!quiet && p !~ "^/dev/") print "OK\t" praw
}
function scope_in() { sd++; SNC[sd] = cwd; SNJ[sd] = jn }
function scope_out(   nm) {
  cwd = SNC[sd]
  while (jn > SNJ[sd]) {
    nm = JN[jn]
    if (JH[jn]) { vals[nm] = JV[jn]; vpoison[nm] = JP[jn] } else { delete vals[nm]; delete vpoison[nm] }
    jn--
  }
  sd--
}
function run_inline(code,   sS, sP, sN, a, b, c, d, g) {
  # executes CODE in the CURRENT shell state (function bodies, trap handlers): effects persist
  sS = S; sP = P; sN = N; a = wv; b = wd; c = wq; d = wany; g = bd
  S = code; N = length(S); P = 1
  parse_seq("")
  S = sS; P = sP; N = sN; wv = a; wd = b; wq = c; wany = d; bd = g
}
function run_code(code,   sS, sP, sN, a, b, c, d, g) {
  sS = S; sP = P; sN = N; a = wv; b = wd; c = wq; d = wany; g = bd
  S = code; N = length(S); P = 1
  scope_in()
  parse_seq("")
  scope_out()
  S = sS; P = sP; N = sN; wv = a; wd = b; wq = c; wany = d; bd = g
}
function safe_subst(inner) {
  # command substitutions whose output is a harmless single component: date +FMT; mktemp under TMPDIR (unless TMPDIR was reassigned here)
  if (index(inner, "%") && inner ~ "^[ \t]*date([ \t]+[+%A-Za-z0-9_:.-]+)*[ \t]*$") return "0"
  if (!("TMPDIR" in vals) && (inner ~ "^[ \t]*mktemp([ \t]+(-[duq]+|--directory|--quiet|--dry-run))*[ \t]*$" || inner ~ "^[ \t]*mktemp([ \t]+(-[duq]+|--directory|--quiet|--dry-run))*[ \t]+(-t|-dt|-td)[ \t]+[A-Za-z0-9_.-]+[ \t]*$")) return ((TMPD == "") ? "/tmp" : TMPD) "/.mktemp"
  return UNRES
}
function brace_len(from,   q, ch, depth, mode) {
  # length (from FROM) up to and including the closing brace of a parameter expansion, quotes honoured; 0 when unterminated
  depth = 1; mode = ""
  for (q = from; q <= N; q++) {
    ch = substr(S, q, 1)
    if (mode == "'") { if (ch == "'") mode = ""; continue }
    if (mode == "\"") { if (ch == "\\") { q++; continue } if (ch == "\"") mode = ""; continue }
    if (ch == "\\") { q++; continue }
    if (ch == "'" || ch == "\"") { mode = ch; continue }
    if (ch == "{") depth++
    else if (ch == "}") { depth--; if (depth == 0) return q - from + 1 }
  }
  return 0
}
function backtick(   j, code, start) {
  start = P
  j = index(substr(S, P + 1), "\140")
  if (j == 0) { wv = wv "\140"; wd = wd "\140"; P++; return }
  code = substr(S, P + 1, j - 1)
  P = P + j + 1
  run_code(code)
  wv = wv safe_subst(code); wd = wd substr(S, start, P - start)
}
function arith_end(from,   depth, j, ch, body) {
  # index of the closing paren of the (( that starts at FROM, or 0 when it is not pure arithmetic (code inside: a semicolon, a command substitution)
  depth = 0
  for (j = from; j <= N; j++) {
    ch = substr(S, j, 1)
    if (ch == "(") depth++
    else if (ch == ")") { depth--; if (depth == 0) break }
  }
  if (depth != 0 || j > N || substr(S, j - 1, 1) != ")") return 0
  body = substr(S, from + 2, j - from - 3)
  if (index(body, ";") || index(body, "$(") || index(body, "\140")) return 0
  return j
}
function dollar(   c2, nm, j, v, e, start, a, b, c, d, g, inner, dflt) {
  c2 = substr(S, P + 1, 1)
  start = P
  if (c2 == "(") {
    if (substr(S, P + 2, 1) == "(") {
      j = arith_end(P + 1)
      if (j > 0) { wv = wv UNRES; wd = wd substr(S, P, j - P + 1); P = j + 1; return }
    }
    P += 2; a = wv; b = wd; c = wq; d = wany; g = bd
    scope_in()
    parse_seq(")")
    scope_out()
    wv = a; wd = b; wq = c; wany = d; bd = g
    inner = substr(S, start + 2, P - start - 3)
    wv = wv safe_subst(inner)
    wd = wd substr(S, start, P - start)
    return
  }
  if (c2 == "{") {
    j = brace_len(P + 2)
    if (j == 0) { wv = wv "$"; wd = wd "$"; P++; return }
    nm = substr(S, P + 2, j - 1)
    if (nm ~ "^[A-Za-z_][A-Za-z0-9_]*$") v = san(getvar(nm))
    else if (nm ~ "^[1-9]$" && (nm in POS)) v = san(POS[nm])
    else if (nm ~ "^[A-Za-z_][A-Za-z0-9_]*:?[?]") { sub(":?[?].*$", "", nm); v = san(getvar(nm)) }
    else if (nm ~ "^[A-Za-z_][A-Za-z0-9_]*:?-") {
      # brace form with a :- / - default: the value when VAR is known and non-empty, else a literal default
      dflt = nm; sub("^[A-Za-z_][A-Za-z0-9_]*:?-", "", dflt); sub(":?-.*$", "", nm)
      v = getvar(nm)
      if (index(v, UNRES) == 0 && v == "") v = (index(dflt, "$") || index(dflt, "\140") || dflt ~ "[\"'\\\\]") ? UNRES : dflt
      v = san(v)
    } else v = UNRES
    wv = wv v; wd = wd substr(S, P, j + 2); P += j + 2
    return
  }
  if (c2 ~ "^[A-Za-z_]$") {
    j = P + 1
    while (j <= N && substr(S, j, 1) ~ "^[A-Za-z0-9_]$") j++
    nm = substr(S, P + 1, j - P - 1)
    wv = wv san(getvar(nm)); wd = wd "$" nm; P = j
    return
  }
  if (c2 == "$") { wv = wv "1"; wd = wd "$$"; P += 2; return }
  if (c2 ~ "^[1-9]$" && (c2 in POS)) { wv = wv san(POS[c2]); wd = wd "$" c2; P += 2; return }
  if (c2 ~ "^[0-9@*?!#-]$") { wv = wv UNRES; wd = wd "$" c2; P += 2; return }
  if (c2 == "'") {
    e = index(substr(S, P + 2), "'")
    if (e > 0) { wv = wv UNRES; wd = wd substr(S, P, e + 2); P += e + 2; return }
  }
  if (c2 == "'" || c2 == "\"") { P++; return }
  wv = wv "$"; wd = wd "$"; P++
}
function dqparse(   c, c2, sp) {
  sp = P; P++
  while (P <= N && !abort) {
    if (--BUDGET < 0) { abort = 1; return }
    c = substr(S, P, 1)
    if (c == "\"") { P++; return }
    if (c == "\\") {
      c2 = substr(S, P + 1, 1)
      if (c2 == "\"" || c2 == "\\" || c2 == "$" || c2 == "\140") { wv = wv c2; wd = wd c2; P += 2 } else { wv = wv c; wd = wd c; P++ }
      continue
    }
    if (c == "$") { dollar(); continue }
    if (c == "\140") { backtick(); continue }
    wv = wv c; wd = wd c; P++
  }
  P = sp + 1; wv = wv "\""; wd = wd "\""
}
function readword(   c, c2, e, lit, sp) {
  wv = ""; wd = ""; wq = 0; wany = 0
  while (P <= N && !abort) {
    if (--BUDGET < 0) { abort = 1; return }
    c = substr(S, P, 1)
    if (ws(c) || isop(c)) break
    if (!wany && c == "~") {
      c2 = substr(S, P + 1, 1)
      if (c2 == "" || c2 == "/" || ws(c2) || isop(c2)) { wany = 1; wv = (HOMEV == "") ? UNRES : HOMEV; wd = "~"; P++; continue }
      wany = 1; wv = UNRES; wd = "~"; P++; continue
    }
    wany = 1
    if (c == "\\") {
      if (P == N) { wv = wv c; wd = wd c; P++; continue }
      c2 = substr(S, P + 1, 1); wv = wv c2; wd = wd c2; wq = 1; P += 2; continue
    }
    if (c == "'") {
      e = index(substr(S, P + 1), "'")
      if (e == 0) { wv = wv c; wd = wd c; P++; continue }
      lit = substr(S, P + 1, e - 1); wv = wv lit; wd = wd lit; wq = 1; P += e + 1; continue
    }
    if (c == "\"") { wq = 1; dqparse(); continue }
    if (c == "$") { dollar(); continue }
    if (c == "\140") { backtick(); continue }
    if (c == "{") bd = 1
    wv = wv c; wd = wd c; P++
  }
}
function skipws() { while (P <= N && ws(substr(S, P, 1))) P++ }
function redirect(c,   c2, c3, pv) {
  c2 = substr(S, P + 1, 1)
  pv = substr(S, P - 1, 1)
  if (c == ">" && (pv == "-" || pv == "=") && (P < 3 || ws(substr(S, P - 2, 1)))) { P++; return }
  if (c2 == "(") { P += 2; scope_in(); parse_seq(")"); scope_out(); return }
  if (c == "<") {
    if (substr(S, P, 3) == "<<<") { P += 3; skipws(); readword(); return }
    if (substr(S, P, 2) == "<<") { P += 2; if (substr(S, P, 1) == "-") P++; skipws(); readword(); return }
    P++; skipws(); readword(); return
  }
  P++
  c2 = substr(S, P, 1)
  if (c2 == ">" || c2 == "|") P++
  else if (c2 == "&") {
    c3 = substr(S, P + 1, 1)
    if (c3 ~ "^[0-9-]$") { P += 2; while (P <= N && substr(S, P, 1) ~ "^[0-9]$") P++; return }
    P++
  }
  skipws()
  if (substr(S, P, 2) == ">(" || substr(S, P, 2) == "<(") return
  bd = 0
  readword()
  judge("W", wd, wv, bd)
}
function is_assign(f, i) { return CD[f, i] ~ "^[A-Za-z_][A-Za-z0-9_]*([[][^]]*[]])?[+]?=" }
function assign(f, i,   nm) {
  nm = CD[f, i]
  if (nm ~ "^[A-Za-z_][A-Za-z0-9_]*[[]") { sub("[[].*$", "", nm); poisonvar(nm); return }
  if (nm ~ "^[A-Za-z_][A-Za-z0-9_]*[+]=") { sub("[+]=.*$", "", nm); poisonvar(nm); return }
  sub("=.*$", "", nm)
  if (nm == "IFS") { ifs = 1; poison_all(); return }
  if (nm == "CDPATH") cdpath = 1
  setvar(nm, substr(CW[f, i], length(nm) + 2))
}
function do_cd(f, i, k, term, inpipe_cmd,   j, w, tgt, have, rest, old, t1, t2) {
  have = 0; old = cwd
  for (j = i + 1; j <= k; j++) {
    w = CW[f, j]
    if (substr(w, 1, 1) == "-" && w != "-") { if (w == "--") continue; continue }
    tgt = w; have = 1; break
  }
  if (!have) { cwd = HOMEV; return }
  if (tgt == "-" || index(tgt, UNRES) || tgt ~ "[ \t{}]") { cwd = ""; return }
  if (cdpath && substr(tgt, 1, 1) != "/") { cwd = ""; return }
  cwd = absp(tgt)
  # a cd piped from / into something, or backgrounded, runs in a subshell: the shell stays where it was
  t1 = substr(term, 1, 1); t2 = substr(term, 2, 1)
  if (inpipe_cmd || (t1 == "|" && t2 != "|") || (t1 == "&" && t2 != "&")) { cwd = old; return }
  # cd X || <something other than exit/return>: a failed cd would leave us elsewhere, so the cwd is unknown
  if (term == "||") { rest = substr(S, P + 2); sub("^[ \t]+", "", rest); if (rest !~ "^(exit|return)([ ;&|)]|$)") cwd = "" }
}
function do_sed(f, i, k,   j, w, opts, inpl, haveS, nop, nf, idx, scr, ffile) {
  opts = 1; inpl = 0; haveS = 0; nop = 0; nf = 0; scr = ""; ffile = 0
  for (j = i + 1; j <= k; j++) {
    w = CW[f, j]
    if (opts && substr(w, 1, 1) == "-" && w != "-") {
      if (w == "--") { opts = 0; continue }
      if (w ~ "^--in-place") { inpl = 1; continue }
      if (w == "--expression") { haveS = 1; j++; scr = scr " " CW[f, j]; continue }
      if (w == "--file") { haveS = 1; ffile = 1; j++; continue }
      if (w ~ "^--expression=") { haveS = 1; scr = scr " " w; continue }
      if (w ~ "^--file=") { haveS = 1; ffile = 1; continue }
      if (w == "--line-length") { j++; continue }
      if (w ~ "^--") continue
      if (w == "-l") { j++; continue }
      if (w ~ "^-[a-zA-Z]*i") inpl = 1
      else if (w ~ "^-[a-zA-Z]*e$") { haveS = 1; j++; scr = scr " " CW[f, j] }
      else if (w ~ "^-[a-zA-Z]*f$") { haveS = 1; ffile = 1; j++ }
      continue
    }
    nop++; idx[nop] = j
  }
  if (!inpl) return
  if (!haveS && nop >= 1) scr = CW[f, idx[1]]
  # sed script commands/flags that write or execute (s///w file, w file, e): not judged, so denied; -f script contents are unknown
  if (ffile || scr ~ "(^|[^A-Za-z_\\\\])[weWE]([ \t;}]|$)") emit("SEDI", "(sed script with a w/e command or flag, or -f)")
  nf = 0
  for (j = ((haveS) ? 1 : 2); j <= nop; j++) { nf++; judge("SEDI", CD[f, idx[j]], CW[f, idx[j]], CB[f, idx[j]]) }
  if (nf == 0) emit("SEDI", "(no file operand)")
}
function code_operand(f, i, k,   j, w) {
  # bash -c CODE: the operand after a flag cluster holding c
  for (j = i + 1; j <= k; j++) {
    w = CW[f, j]
    if (w == "-o" || w == "+o") { j++; continue }
    if (w ~ "^-[a-zA-Z]*c[a-zA-Z]*$") { if (j + 1 <= k) run_code(CW[f, j + 1]); return }
    if (substr(w, 1, 1) == "-" || substr(w, 1, 1) == "+") continue
    return
  }
}
function do_ssh(f, i, k,   j, w, code) {
  j = i + 1
  while (j <= k && substr(CW[f, j], 1, 1) == "-") {
    w = CW[f, j]
    if (w ~ "^-[bcDEeFIiJLlmOopQRSWw]$") j++
    j++
  }
  j++
  code = ""
  for (; j <= k; j++) code = code ((code == "") ? "" : " ") CW[f, j]
  if (code != "") run_code(code)
}
function process_cmd(f, k, term, inpipe_cmd,   n, i, nm) {
  n = 0
  while (n < k && is_assign(f, n + 1)) n++
  if (n == 0 || n == k) { process_cmd2(f, k, term, inpipe_cmd); return }
  # VAR=x cmd: the assignment lives for that one command only
  pd++
  for (i = 1; i <= n; i++) {
    nm = CD[f, i]; sub("[+]?=.*$", "", nm); sub("[[].*$", "", nm)
    PAn[pd, i] = nm; PAh[pd, nm] = (nm in vals)
    if (PAh[pd, nm]) { PAv[pd, nm] = vals[nm]; PAp[pd, nm] = vpoison[nm] }
  }
  process_cmd2(f, k, term, inpipe_cmd)
  for (i = 1; i <= n; i++) {
    nm = PAn[pd, i]
    jlog(nm)
    if (PAh[pd, nm]) { vals[nm] = PAv[pd, nm]; if (PAp[pd, nm] != "") vpoison[nm] = PAp[pd, nm]; else delete vpoison[nm] }
    else { delete vals[nm]; delete vpoison[nm] }
  }
  pd--
}
function call_fn(nm, f, i, k,   p, d) {
  # the body runs HERE, in the caller's shell (cwd, variables, positional parameters); its effects persist like in bash
  if (FNunk[nm]) { poison_all(); return }
  pn++; d = pn
  for (p = 1; p <= 9; p++) { SPh[d, p] = (p in POS); if (SPh[d, p]) SPv[d, p] = POS[p]; delete POS[p] }
  for (p = 1; p <= 9 && i + p <= k; p++) POS[p] = CW[f, i + p]
  if (!FNact[nm]) { FNact[nm] = 1; run_inline(FNbody[nm]); FNact[nm] = 0 }
  for (p = 1; p <= 9; p++) { delete POS[p]; if (SPh[d, p]) POS[p] = SPv[d, p] }
  pn--
}
function def_function(fn,   bs, j) {
  # P is just after the name (or after the parens): a brace body is registered (judged at each call); any other form is unknown => its call poisons everything
  while (P <= N && (ws(substr(S, P, 1)) || substr(S, P, 1) == ";")) P++
  if (substr(S, P, 1) != "{") { FNdef[fn] = 1; FNunk[fn] = 1; FNbody[fn] = ""; return }
  bs = P; j = brace_len(bs + 1)
  if (j == 0) { emit("W", "(unterminated function body)"); abort = 1; return }
  FNdef[fn] = 1; FNunk[fn] = 0; FNbody[fn] = substr(S, bs + 1, j - 1)
  P = bs + 1 + j
}
function process_cmd2(f, k, term, inpipe_cmd,   i, w, nm, base, j, moved, sk, safe, first) {
  i = 1
  for (;;) {
    while (i <= k && is_assign(f, i)) { assign(f, i); i++ }
    if (i > k) return
    w = CW[f, i]
    if (!CQ[f, i] && (w == "then" || w == "do" || w == "else" || w == "elif" || w == "if" || w == "while" || w == "until" || w == "!" || w == "{" || w == "}" || w == "time" || w == "coproc" || w == "function")) { if (w == "function") poison_all(); i++; continue }
    base = w; sub("^.*/", "", base)
    moved = 1
    if (base == "sudo" || base == "env" || base == "command" || base == "exec" || base == "nohup" || base == "timeout" || base == "nice" || base == "builtin") {
      i++
      while (i <= k && substr(CW[f, i], 1, 1) == "-") {
        w = CW[f, i]
        if ((base == "sudo" && w ~ "^-[ughCprtUDR]$") || (base == "env" && w == "-u") || (base == "nice" && w == "-n") || (base == "timeout" && w ~ "^-[ks]$")) i++
        i++
      }
      if (base == "timeout" && i <= k && CW[f, i] ~ "^[0-9.]+[smhd]?$") i++
      continue
    }
    break
  }
  if (index(CW[f, i], UNRES) && index(CW[f, i], "/") == 0) {
    # a command word nobody can name ($n, $(echo f)): it may be ANY defined function or builtin — judge every body, then poison
    for (nm in FNdef) if (!FNunk[nm] && !FNact[nm]) { FNact[nm] = 1; run_code(FNbody[nm]); FNact[nm] = 0 }
    poison_all()
    return
  }
  if (base == "trap") {
    for (j = i + 1; j <= k; j++) { if (substr(CW[f, j], 1, 1) == "-") continue; if (CW[f, j] != "") run_inline(CW[f, j]); break }
    return
  }
  if (base in FNdef) { call_fn(base, f, i, k); return }
  for (j = i; j <= k; j++) {
    nm = CW[f, j]; sub("^.*/", "", nm)
    if (nm == "bash" || nm == "sh" || nm == "zsh" || nm == "dash" || nm == "ksh") code_operand(f, j, k)
  }
  if (base == "for" || base == "select") {
    nm = CW[f, i + 1]
    # a loop over LITERAL single-component words (or a numeric range) keeps the variable safe; anything else poisons it
    safe = (CW[f, i + 2] == "in" && k >= i + 3); first = ""
    for (j = i + 3; j <= k && safe; j++) {
      w = CW[f, j]
      if (CD[f, j] ~ "^[$][(]seq [0-9 ]+[)]$" || w ~ "^[{][0-9]+[.][.][0-9]+[}]$") { if (first == "") first = "1"; continue }
      if (index(w, UNRES) == 0 && w ~ "^[A-Za-z0-9_][A-Za-z0-9_.-]*$" && w != "..") { if (first == "") first = w; continue }
      safe = 0
    }
    if (safe) setvar(nm, first); else poisonvar(nm)
    return
  }
  if (base == "read" || base == "mapfile" || base == "readarray" || base == "getopts") {
    for (j = i + 1; j <= k; j++) if (CW[f, j] ~ "^[A-Za-z_][A-Za-z0-9_]*$") poisonvar(CW[f, j])
    return
  }
  if (base == "export" || base == "declare" || base == "local" || base == "readonly" || base == "typeset") {
    for (j = i + 1; j <= k; j++) {
      if (CW[f, j] ~ "^-[a-zA-Z]*n") poison_all()
      if (is_assign(f, j)) {
        if (base == "local") { nm = CD[f, j]; sub("[+]?=.*$", "", nm); sub("[[].*$", "", nm); poisonvar(nm) } else assign(f, j)
      }
    }
    return
  }
  if (base == "source" || base == ".") { poison_all(); return }
  if (base == "cd" || base == "pushd") { do_cd(f, i, k, term, inpipe_cmd); return }
  if (base == "popd") { cwd = ""; return }
  if (base == "unset") {
    for (j = i + 1; j <= k; j++) if (CW[f, j] ~ "^[A-Za-z_][A-Za-z0-9_]*$") poisonvar(CW[f, j])
    return
  }
  if (base == "printf") {
    for (j = i + 1; j < k; j++) if (CW[f, j] == "-v") poisonvar(CW[f, j + 1])
    return
  }
  if (base == "tee") {
    sk = 0
    for (j = i + 1; j <= k; j++) {
      if (!sk && substr(CW[f, j], 1, 1) == "-" && CW[f, j] != "-") { if (CW[f, j] == "--") sk = 1; continue }
      judge("W", CD[f, j], CW[f, j], CB[f, j])
    }
    return
  }
  if (base == "sed") { do_sed(f, i, k); return }
  if (base == "eval") {
    sk = ""
    for (j = i + 1; j <= k; j++) sk = sk ((sk == "") ? "" : " ") CW[f, j]
    if (sk != "") run_code(sk)
    poison_all()
    return
  }
  if (base == "ssh") do_ssh(f, i, k)
}
function array_body() {
  while (P <= N && !abort) {
    skipws()
    c9 = substr(S, P, 1)
    if (c9 == ")") { P++; return }
    if (c9 == ";" || c9 == "&" || c9 == "|" || c9 == "<" || c9 == ">" || c9 == "(") { P++; continue }
    readword()
  }
}
function parse_cmd(   f, k, c, c2, e, nxt, inpipe, q2) {
  fr++; f = fr; k = 0
  inpipe = 0; q2 = P - 1
  while (q2 >= 1 && ws(substr(S, q2, 1))) q2--
  if (substr(S, q2, 1) == "|" && substr(S, q2 - 1, 1) != "|") inpipe = 1
  while (P <= N && !abort) {
    c = substr(S, P, 1)
    if (ws(c)) { P++; continue }
    if (c == ";" || c == "|" || c == ")") break
    if (c == "&") {
      if (substr(S, P + 1, 1) == ">") { P++; redirect(">"); continue }
      break
    }
    if (c == "(") {
      if (k >= 1 && substr(S, P - 1, 1) == "=" && CD[f, k] ~ "^[A-Za-z_][A-Za-z0-9_]*[+]?=$") {
        # NAME=( words ): an array assignment — the words are DATA (their substitutions are still scanned), the variable becomes unknown
        e = CD[f, k]; sub("[+]?=$", "", e); P++
        array_body()
        poisonvar(e); k--
        continue
      }
      if ((k == 1 || (k == 2 && CW[f, 1] == "function" && !CQ[f, 1])) && substr(S, P + 1, 1) == ")") {
        # name() BODY and function name() BODY: register the function (the body is judged at each call)
        P += 2
        def_function(CW[f, k])
        k = 0
        continue
      }
      break
    }
    if (c == ">" || c == "<") { redirect(c); continue }
    bd = 0
    readword()
    if (wany && !wq && wv ~ "^[0-9]+$" && (substr(S, P, 1) == ">" || substr(S, P, 1) == "<")) continue
    k++; CW[f, k] = wv; CD[f, k] = wd; CQ[f, k] = wq; CB[f, k] = bd
    if (k == 2 && CW[f, 1] == "function" && !CQ[f, 1]) {
      # function name { BODY }
      q2 = P
      while (q2 <= N && ws(substr(S, q2, 1))) q2++
      if (substr(S, q2, 1) == "{") { P = q2; def_function(CW[f, 2]); k = 0; continue }
    }
    if (k == 1 && wv == "[[" && !wq) {
      e = index(substr(S, P), "]]")
      if (e > 0) P += e + 1
    }
  }
  process_cmd(f, k, substr(S, P, 2), inpipe)
  fr--
}
function parse_seq(cl,   c, p0) {
  while (P <= N && !abort) {
    p0 = P
    skipws()
    if (P > N) break
    c = substr(S, P, 1)
    if (c == ";" || c == "&" || c == "|") { P++; continue }
    if (c == ")") { P++; if (cl == ")") return; continue }
    if (c == "(") {
      if (substr(S, P + 1, 1) == "(") {
        q = arith_end(P)
        if (q > 0) { P = q + 1; continue }
      }
      P++
      scope_in()
      parse_seq(")")
      scope_out()
      continue
    }
    parse_cmd()
    if (P == p0) P++
  }
}
BEGIN { UNRES = sprintf("%c", 1); S = "" }
{ S = S $0 }
function main(   n0, D, i, c) {
  n0 = length(S); D = ""
  for (i = 1; i <= n0; i++) {
    c = substr(S, i, 1)
    if (c == "\\" && i < n0) { i++; c = substr(S, i, 1) }
    D = D c
  }
  S = D; N = length(S); P = 1
  HOMEV = envget("HOME")
  if (HOMEV != "") HOMEV = norm(HOMEV)
  cwd = envget("RG_CWD")
  if (substr(cwd, 1, 1) == "/") cwd = norm(cwd); else cwd = ""
  OHOME = envget("ORCHESTRA_HOME")
  if (substr(OHOME, 1, 1) == "/") OHOME = norm(OHOME); else OHOME = ""
  TMPD = envget("TMPDIR")
  if (TMPD ~ "^/[^/]+/[^/]") TMPD = norm(TMPD); else TMPD = ""
  if (TMPD == HOMEV) TMPD = ""
  fr = 0; sd = 0; pd = 0; pn = 0; jn = 0; BUDGET = 300000; abort = 0; quiet = 0; envpoison = 0; ifs = 0
  cdpath = (envget("CDPATH") != "")
  parse_seq("")
  if (abort) emit("W", "(command too complex for the write scanner)")
}
function envget(nm) { return (nm in ENVIRON) ? ENVIRON[nm] : "" }
END { main() }
`;
