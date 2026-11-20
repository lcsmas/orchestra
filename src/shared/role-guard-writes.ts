// Role guard write-target scanner (#475). POSIX awk run by role-guard.sh on the decoded Bash command: a small quote-aware shell reader
// that finds the files a command WRITES (`>` `>>` `>|` `&>` redirects, `tee`, `sed -i`) and prints each one that does NOT resolve into
// the role's scratch as `W<TAB>target` / `SEDI<TAB>target`. Quoted text is DATA unless the command is a wrapper that executes it
// (`bash|sh|zsh|dash|ksh -c`, `eval`, `ssh host`, `$( )`, backticks, `<( )`). Resolved: `VAR` / `${VAR}` / `~` / `..` / relative-to-cwd
// (the payload cwd, moved by `cd` in the same command, scoped by subshells). Anything unresolvable is NOT scratch (fail closed).
// No backtick and no `${` in here: this text lives in a String.raw template.

export const AWK_WRITES = String.raw`
function ws(c) { return c == " " || c == "\t" || c == "\r" }
function isop(c) { return c == ";" || c == "&" || c == "|" || c == "(" || c == ")" || c == "<" || c == ">" }
function emit(kind, disp) { print kind "\t" disp }
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
function getvar(nm) {
  if (nm in vals) return (vpoison[nm]) ? UNRES : vals[nm]
  if (nm == "PWD") return (cwd == "") ? UNRES : cwd
  if ((nm in ENVIRON) && ENVIRON[nm] != "") return ENVIRON[nm]
  if (nm == "TMPDIR") return "/tmp/.TMPDIR"
  return UNRES
}
function okpath(v) { return index(v, UNRES) == 0 && scratch(absp(v)) }
function setvar(nm, v) {
  if ((nm in vals) && !(okpath(vals[nm]) && okpath(v))) vpoison[nm] = 1
  vals[nm] = v
}
function judge(kind, disp, v,   k, pre, rest) {
  k = index(v, UNRES)
  if (k > 0) {
    # e.g. TMPDIR/run-N.log: an unknown part is tolerated only inside the LAST component, under a resolved scratch directory
    pre = substr(v, 1, k - 1); rest = substr(v, k)
    sub("[^/]*$", "", pre)
    if (index(rest, "/") == 0 && pre != "" && scratch(absp(pre "x"))) return
    emit(kind, disp); return
  }
  if (!scratch(absp(v))) emit(kind, disp)
}
function scope_in(   n) {
  sd++; SNC[sd] = cwd; SNL[sd] = ""
  for (n in vals) { SNV[sd, n] = vals[n]; SNP[sd, n] = vpoison[n]; SNL[sd] = SNL[sd] " " n }
}
function scope_out(   n, a, m, i) {
  cwd = SNC[sd]
  split("", vals); split("", vpoison)
  m = split(SNL[sd], a, " ")
  for (i = 1; i <= m; i++) { n = a[i]; vals[n] = SNV[sd, n]; if (SNP[sd, n] != "") vpoison[n] = SNP[sd, n] }
  sd--
}
function run_code(code,   sS, sP, sN, a, b, c, d) {
  sS = S; sP = P; sN = N; a = wv; b = wd; c = wq; d = wany
  S = code; N = length(S); P = 1
  scope_in()
  parse_seq("")
  scope_out()
  S = sS; P = sP; N = sN; wv = a; wd = b; wq = c; wany = d
}
function backtick(   j, code, start) {
  start = P
  j = index(substr(S, P + 1), "\140")
  if (j == 0) { wv = wv "\140"; wd = wd "\140"; P++; return }
  code = substr(S, P + 1, j - 1)
  P = P + j + 1
  run_code(code)
  wv = wv UNRES; wd = wd substr(S, start, P - start)
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
function dollar(   c2, nm, j, v, e, start, a, b, c, d, inner, dflt) {
  c2 = substr(S, P + 1, 1)
  start = P
  if (c2 == "(") {
    if (substr(S, P + 2, 1) == "(") {
      j = arith_end(P + 1)
      if (j > 0) { wv = wv UNRES; wd = wd substr(S, P, j - P + 1); P = j + 1; return }
    }
    P += 2; a = wv; b = wd; c = wq; d = wany
    scope_in()
    parse_seq(")")
    scope_out()
    wv = a; wd = b; wq = c; wany = d
    inner = substr(S, start + 2, P - start - 3)
    # mktemp [-d|-u|-q] or mktemp -t TEMPLATE creates under TMPDIR (/tmp when unset): the role's scratch
    if (inner ~ "^[ \t]*mktemp([ \t]+(-[duq]+|--directory|--quiet|--dry-run))*[ \t]*$" || inner ~ "^[ \t]*mktemp([ \t]+(-[duq]+|--directory|--quiet|--dry-run))*[ \t]+(-t|-dt|-td)[ \t]+[A-Za-z0-9_.-]+[ \t]*$") wv = wv ((TMPD == "") ? "/tmp" : TMPD) "/.mktemp"
    else wv = wv UNRES
    wd = wd substr(S, start, P - start)
    return
  }
  if (c2 == "{") {
    j = index(substr(S, P + 2), "}")
    if (j == 0) { wv = wv "$"; wd = wd "$"; P++; return }
    nm = substr(S, P + 2, j - 1)
    if (nm ~ "^[A-Za-z_][A-Za-z0-9_]*$") v = getvar(nm)
    else if (nm ~ "^[A-Za-z_][A-Za-z0-9_]*:?-") {
      # brace form with a :- / - default: the value when VAR is known and non-empty, else a literal default
      dflt = nm; sub("^[A-Za-z_][A-Za-z0-9_]*:?-", "", dflt); sub(":?-.*$", "", nm)
      v = getvar(nm)
      if (index(v, UNRES) == 0 && v == "") v = (index(dflt, "$") || index(dflt, "\140")) ? UNRES : dflt
    } else v = UNRES
    wv = wv v; wd = wd substr(S, P, j + 2); P += j + 2
    return
  }
  if (c2 ~ "^[A-Za-z_]$") {
    j = P + 1
    while (j <= N && substr(S, j, 1) ~ "^[A-Za-z0-9_]$") j++
    nm = substr(S, P + 1, j - P - 1)
    wv = wv getvar(nm); wd = wd "$" nm; P = j
    return
  }
  if (c2 ~ "^[0-9@*?$!#-]$") { wv = wv UNRES; wd = wd "$" c2; P += 2; return }
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
  readword()
  judge("W", wd, wv)
}
function is_assign(f, i) { return CD[f, i] ~ "^[A-Za-z_][A-Za-z0-9_]*([[][^]]*[]])?[+]?=" }
function assign(f, i,   nm) {
  nm = CD[f, i]
  if (nm ~ "^[A-Za-z_][A-Za-z0-9_]*[[]") { sub("[[].*$", "", nm); vals[nm] = UNRES; vpoison[nm] = 1; return }
  if (nm ~ "^[A-Za-z_][A-Za-z0-9_]*[+]=") { sub("[+]=.*$", "", nm); vals[nm] = UNRES; vpoison[nm] = 1; return }
  sub("=.*$", "", nm)
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
  if (tgt == "-" || index(tgt, UNRES)) { cwd = ""; return }
  cwd = absp(tgt)
  # a cd piped from / into something, or backgrounded, runs in a subshell: the shell stays where it was
  t1 = substr(term, 1, 1); t2 = substr(term, 2, 1)
  if (inpipe_cmd || (t1 == "|" && t2 != "|") || (t1 == "&" && t2 != "&")) { cwd = old; return }
  # cd X || <something other than exit/return>: a failed cd would leave us elsewhere, so the cwd is unknown
  if (term == "||") { rest = substr(S, P + 2); sub("^[ \t]+", "", rest); if (rest !~ "^(exit|return)([ ;&|)]|$)") cwd = "" }
}
function do_sed(f, i, k,   j, w, opts, inpl, haveS, nop, nf, idx) {
  opts = 1; inpl = 0; haveS = 0; nop = 0; nf = 0
  for (j = i + 1; j <= k; j++) {
    w = CW[f, j]
    if (opts && substr(w, 1, 1) == "-" && w != "-") {
      if (w == "--") { opts = 0; continue }
      if (w ~ "^--in-place") { inpl = 1; continue }
      if (w == "--expression" || w == "--file") { haveS = 1; j++; continue }
      if (w ~ "^--expression=" || w ~ "^--file=") { haveS = 1; continue }
      if (w == "--line-length") { j++; continue }
      if (w ~ "^--") continue
      if (w == "-l") { j++; continue }
      if (w ~ "^-[a-zA-Z]*i") inpl = 1
      else if (w ~ "^-[a-zA-Z]*[ef]$") { haveS = 1; j++ }
      continue
    }
    nop++; idx[nop] = j
  }
  if (!inpl) return
  nf = 0
  for (j = ((haveS) ? 1 : 2); j <= nop; j++) { nf++; judge("SEDI", CD[f, idx[j]], CW[f, idx[j]]) }
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
function process_cmd(f, k, term, inpipe_cmd,   i, w, nm, base, j, moved, sk) {
  i = 1
  for (;;) {
    while (i <= k && is_assign(f, i)) { assign(f, i); i++ }
    if (i > k) return
    w = CW[f, i]
    if (!CQ[f, i] && (w == "then" || w == "do" || w == "else" || w == "elif" || w == "if" || w == "while" || w == "until" || w == "!" || w == "{" || w == "}" || w == "time" || w == "coproc" || w == "function")) { i++; continue }
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
  for (j = i; j <= k; j++) {
    nm = CW[f, j]; sub("^.*/", "", nm)
    if (nm == "bash" || nm == "sh" || nm == "zsh" || nm == "dash" || nm == "ksh") code_operand(f, j, k)
  }
  if (base == "for" || base == "select") { nm = CW[f, i + 1]; vals[nm] = UNRES; vpoison[nm] = 1; return }
  if (base == "read" || base == "mapfile" || base == "readarray" || base == "getopts") {
    for (j = i + 1; j <= k; j++) if (CW[f, j] ~ "^[A-Za-z_][A-Za-z0-9_]*$") { vals[CW[f, j]] = UNRES; vpoison[CW[f, j]] = 1 }
    return
  }
  if (base == "export" || base == "declare" || base == "local" || base == "readonly" || base == "typeset") {
    for (j = i + 1; j <= k; j++) if (is_assign(f, j)) assign(f, j)
    return
  }
  if (base == "cd" || base == "pushd") { do_cd(f, i, k, term, inpipe_cmd); return }
  if (base == "popd") { cwd = ""; return }
  if (base == "unset") {
    for (j = i + 1; j <= k; j++) if (CW[f, j] ~ "^[A-Za-z_][A-Za-z0-9_]*$") { vals[CW[f, j]] = UNRES; vpoison[CW[f, j]] = 1 }
    return
  }
  if (base == "printf") {
    for (j = i + 1; j < k; j++) if (CW[f, j] == "-v") { vals[CW[f, j + 1]] = UNRES; vpoison[CW[f, j + 1]] = 1 }
    return
  }
  if (base == "tee") {
    sk = 0
    for (j = i + 1; j <= k; j++) {
      if (!sk && substr(CW[f, j], 1, 1) == "-" && CW[f, j] != "-") { if (CW[f, j] == "--") sk = 1; continue }
      judge("W", CD[f, j], CW[f, j])
    }
    return
  }
  if (base == "sed") { do_sed(f, i, k); return }
  if (base == "eval") {
    sk = ""
    for (j = i + 1; j <= k; j++) sk = sk ((sk == "") ? "" : " ") CW[f, j]
    if (sk != "") run_code(sk)
    return
  }
  if (base == "ssh") do_ssh(f, i, k)
}
function parse_cmd(   f, k, c, c2, e, nxt, bs, be, depth, body, ch, inpipe, q2) {
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
      if (k == 1 && substr(S, P + 1, 1) == ")") {
        # name() { body } — a function DEFINITION: its body runs elsewhere, so its cd / writes are judged in isolation
        P += 2; skipws()
        if (substr(S, P, 1) == "{") {
          depth = 0; bs = P
          for (be = P; be <= N; be++) { ch = substr(S, be, 1); if (ch == "{") depth++; else if (ch == "}") { depth--; if (depth == 0) break } }
          body = substr(S, bs + 1, be - bs - 1)
          P = be + 1
          run_code(body)
        }
        k = 0
        continue
      }
      break
    }
    if (c == ">" || c == "<") { redirect(c); continue }
    readword()
    if (wany && !wq && wv ~ "^[0-9]+$" && (substr(S, P, 1) == ">" || substr(S, P, 1) == "<")) continue
    k++; CW[f, k] = wv; CD[f, k] = wd; CQ[f, k] = wq
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
  fr = 0; sd = 0; BUDGET = 300000; abort = 0
  parse_seq("")
  if (abort) emit("W", "(command too complex for the write scanner)")
}
function envget(nm) { return (nm in ENVIRON) ? ENVIRON[nm] : "" }
END { main() }
`;
