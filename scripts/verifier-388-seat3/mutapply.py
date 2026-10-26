import json,sys
spec=json.load(open(sys.argv[1]))
done=[]
for f,old,new in spec:
    s=open(f).read(); n=s.count(old)
    if n!=1:
        print(f"  APPLY FAILED: {f}: string occurs {n}x"); sys.exit(1)
    open(f,'w').write(s.replace(old,new)); done.append(f)
print(f"  APPLIED {len(spec)} edit(s), each string live exactly once")
