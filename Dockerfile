# RingBack production image.
# Zero runtime dependencies, so this stays small and starts instantly.

FROM node:22-alpine

WORKDIR /app

# Only the app files; there is no package install step because there are no deps.
COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY public ./public

# Persist the SQLite database outside the image layer.
RUN mkdir -p /data
ENV RINGBACK_DATA_DIR=/data
ENV PORT=8080
ENV HOST=0.0.0.0
ENV NODE_ENV=production

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
