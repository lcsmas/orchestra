#!/bin/sh
# Q9 research (NOT shipped): runs as the MAIN process of a fresh delegated scope S (systemd-run --scope -p Delegate=yes), builds the leaves, moves ITSELF (a brand-new process of ours,
# never an existing one) into the keeper leaf K, and execs the keeper. argv: <layout twoleaf|toolsleaf> <hardBytes> <cmd> <args...>
# S (the scope) has NO MemoryMax in these layouts; the cap lives on the leaf W: twoleaf = CLI + tools in W; toolsleaf = only the tools in W (each tool shell moves itself in, see the tool wrapper).
layout=$1; hard=$2; shift 2
S=/sys/fs/cgroup$(sed -n 's/^0:://p' /proc/self/cgroup)
mkdir "$S/k" "$S/w" || exit 97
echo $$ > "$S/k/cgroup.procs" || exit 98
echo +memory > "$S/cgroup.subtree_control" || exit 99
echo "$hard" > "$S/w/memory.max" || exit 100
echo 0 > "$S/w/memory.swap.max" 2>/dev/null
export ORCHESTRA_Q9_LAYOUT="$layout" ORCHESTRA_Q9_S="$S" ORCHESTRA_Q9_W="$S/w" ORCHESTRA_Q9_K="$S/k"
exec "$@"
