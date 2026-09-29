import sys
f, old, new = sys.argv[1:4]
s = open(f).read()
assert s.count(old) == 1, ('count', s.count(old), old)
open(f, 'w').write(s.replace(old, new))
