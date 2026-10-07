# MikDrop: image nhỏ cho mọi máy chủ Linux có Docker (VPS, Raspberry Pi, NAS...)
#   Chạy trong LAN:  docker run --network host mikdrop         (cần host network để thấy LAN và mDNS)
#   Chạy online:     docker compose up -d                      (xem docker-compose.yml, có HTTPS tự động)
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY public ./public

USER node
ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "server.js"]
