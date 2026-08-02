FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS bun-runtime

FROM node:22-bookworm@sha256:7725a5c2c83eed1d36258c66efae14b1ceccd021db9ed1d9559d3335ed3d68ed

RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  git \
  jq \
  ripgrep \
  sudo \
  && rm -rf /var/lib/apt/lists/*

COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx \
  && npm install -g @earendil-works/pi-coding-agent@0.83.0

ARG AGENT_UID=1000
ARG AGENT_GID=1000
RUN groupmod -o -g "${AGENT_GID}" node \
  && usermod -o -u "${AGENT_UID}" -g "${AGENT_GID}" -d /home/agent -m -l agent node \
  && mkdir -p /home/agent/.pi/agent \
  && chown -R "${AGENT_UID}:${AGENT_GID}" /home/agent \
  && echo "agent ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/agent \
  && chmod 0440 /etc/sudoers.d/agent

USER ${AGENT_UID}:${AGENT_GID}
ENV HOME=/home/agent
ENV PI_CODING_AGENT_DIR=/home/agent/.pi/agent
WORKDIR /home/agent

ENTRYPOINT ["sleep", "infinity"]
