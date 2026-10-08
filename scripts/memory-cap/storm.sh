#!/bin/bash
# A kill STORM with SEVERAL tool-tree processes alive at all times (review-2 F2): <workers> loops, each running <rounds> children that touch 400 MB (the scope cannot hold it) with 200 ms between them.
# More than 10 kills in under 5 s exceed the kernel's printk ratelimit (measured: 30 kills -> 10 journal lines), so the journal holds FEWER `oom-kill:` lines than kills - the case where a stale line must never be
# labelled «kernel». Several loops (not one back-to-back chain) keep tool candidates alive, so the cap's promise - tools die, the session lives - is what the kernel can honour.   argv: <workers> <rounds>
workers=${1:-8}
rounds=${2:-4}
for k in $(seq "$workers"); do
  (
    for i in $(seq "$rounds"); do
      python3 -c 'b = bytearray(b"\xa5") * (400 * 1024 * 1024)' 2>/dev/null
      sleep 0.2
    done
  ) &
done
wait
echo "storm: done"
