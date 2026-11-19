# resctl as a container's main command — no systemd. Build from this directory:  docker build -t resctl .
# Run:  docker run -d --init --name resctl -v resctl-state:/var/lib/resctl resctl
#   `--init` (tini) reaps the zombies of orphaned lane processes that reparent to PID 1; without it `serve` still works and exits 0 on `docker stop`.
# Callers share the daemon's PID namespace (`docker exec resctl resctl run start --owner <pid>`) — a run's owner and lanes must be visible to it.
FROM node:22-slim
WORKDIR /opt/resctl
COPY package.json ./
COPY bin ./bin
COPY src ./src
ENV RESCTL_STATE_DIR=/var/lib/resctl
VOLUME /var/lib/resctl
ENTRYPOINT ["node", "/opt/resctl/bin/resctl.mjs"]
CMD ["serve"]
