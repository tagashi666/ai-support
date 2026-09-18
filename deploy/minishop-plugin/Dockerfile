ARG MINISHOP_BACKEND_IMAGE=docker.io/3252a8/remnawave-minishop-backend:latest
FROM ${MINISHOP_BACKEND_IMAGE}

USER root
COPY deploy/minishop-plugin /tmp/minishop-ai-support-plugin
RUN python -m pip install --no-cache-dir /tmp/minishop-ai-support-plugin \
    && rm -rf /tmp/minishop-ai-support-plugin

# The upstream image currently runs as root. Keep its original runtime user
# instead of guessing a UID and breaking access to MiniShop's data directory.
