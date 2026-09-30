#!/bin/bash
# samples count of processes whose argv mentions my isolated HOME every 0.3s; logs peak
peak=0; end=$((SECONDS+${1:-90}))
while [ $SECONDS -lt $end ]; do
  n=$(ps -eo args | grep -F '/home/lmas/rd/' | grep -vc -e grep -e sampler)
  [ "$n" -gt "$peak" ] && peak=$n
  sleep 0.3
done
echo "PEAK=$peak FINAL=$(ps -eo args | grep -F '/home/lmas/rd/' | grep -vc -e grep -e sampler)"
