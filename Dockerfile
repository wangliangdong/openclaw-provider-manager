# openclaw-provider-manager
#
# Zero-dependency Node image. The app talks to the OpenClaw Gateway over its
# admin HTTP RPC endpoint only — it never mounts or edits openclaw.json, and it
# never needs docker.sock.

FROM node:24-alpine

ENV NODE_ENV=production \
    PM_PORT=8891 \
    PM_BIND=0.0.0.0 \
    OPENCLAW_GATEWAY_URL=http://openclaw-gateway:18789

WORKDIR /app

# Copy only what the runtime needs.
COPY package.json ./
COPY server.js ./
COPY lib/ ./lib/
COPY public/ ./public/

# Run unprivileged. `node` (uid 1000) already exists in the base image.
USER node

EXPOSE 8891

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PM_PORT||8891)+'/api/session').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
