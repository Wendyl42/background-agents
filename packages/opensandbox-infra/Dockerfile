ARG NODE_IMAGE=node:22-bookworm-slim
ARG PYTHON_IMAGE=python:3.12-slim-bookworm
FROM ${NODE_IMAGE} AS node
FROM ${PYTHON_IMAGE}
ARG DEBIAN_MIRROR=https://deb.debian.org

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && rm -f /etc/apt/apt.conf.d/docker-clean \
    && python -c 'import os; from pathlib import Path; p=Path("/etc/apt/sources.list.d/debian.sources"); p.write_text(p.read_text().replace("http://deb.debian.org", os.environ["DEBIAN_MIRROR"]))' \
    && apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 update \
    && apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 install -y --no-install-recommends git gh curl ca-certificates \
       openssh-client build-essential procps \
    && rm -rf /var/lib/apt/lists/*

COPY packages/sandbox-runtime /opt/openinspect-runtime
ARG PIP_INDEX_URL=https://pypi.org/simple
RUN pip install --no-cache-dir -e /opt/openinspect-runtime \
    && mkdir -p /app /workspace /app/opencode-deps /root/.config/opencode \
    && ln -s /opt/openinspect-runtime/src/sandbox_runtime /app/sandbox_runtime

# Read the existing manifest instead of introducing another OpenCode version pin.
RUN OPENCODE_VERSION=$(python -c 'from sandbox_runtime.toolchain import TOOLCHAIN; print(TOOLCHAIN["opencode"])') \
    && npm install -g "opencode-ai@${OPENCODE_VERSION}" "@opencode-ai/plugin@${OPENCODE_VERSION}" \
    && cd /app/opencode-deps \
    && npm install --save-exact "@opencode-ai/plugin@${OPENCODE_VERSION}" \
    && cp -a /app/opencode-deps/. /root/.config/opencode/ \
    && python -m sandbox_runtime.toolchain --capture /app/oi-toolchain.json \
    && python -c 'from sandbox_runtime.toolchain import TOOLCHAIN, capture_toolchain; v=capture_toolchain()["versions"]; assert v["opencode"] == v["opencode_plugin"] == TOOLCHAIN["opencode"]; assert v["node"].split(".")[0] == TOOLCHAIN["node_major"]'

ENV PYTHONUNBUFFERED=1 NODE_PATH=/usr/local/lib/node_modules SANDBOX_VERSION=opensandbox-v1
WORKDIR /workspace
ENTRYPOINT ["python", "-m", "sandbox_runtime.entrypoint"]
