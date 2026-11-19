# resctl as a container's main command — no systemd. Build from this directory:  docker build -t resctl .   (needs network once: apt installs tini)
# Run:  docker run -d --name resctl -v resctl-state:/var/lib/resctl resctl
# tini is PID 1: orphaned lane processes reparent to PID 1, and node cannot reap them — without an init every killed escapee stays a zombie (<defunct>)
# until the pid table or --pids-limit runs out. tini also forwards SIGTERM, so `docker stop` ends `serve` with exit code 0.
# Callers share the daemon's PID namespace (`docker exec resctl node /opt/resctl/bin/resctl.mjs run start --owner <pid>`) — a run's owner and lanes must be visible to it.
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/resctl
COPY package.json ./
COPY bin ./bin
COPY src ./src
ENV RESCTL_STATE_DIR=/var/lib/resctl
VOLUME /var/lib/resctl
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/opt/resctl/bin/resctl.mjs"]
CMD ["serve"]
