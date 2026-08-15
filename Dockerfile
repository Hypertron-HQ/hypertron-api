# Multi-stage production image for HyperTone Payments API (Render)

FROM node:20-alpine AS builder
WORKDIR /app
RUN apk add --no-cache openssl libc6-compat
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate

COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma
# prisma generate reads the schema only; this URL is not used at runtime
ENV DATABASE_URL="mongodb://127.0.0.1:27017/hypertron_api"
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm exec prisma generate && pnpm build && pnpm prune --prod

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache openssl libc6-compat \
  && addgroup -S hypertron && adduser -S hypertron -G hypertron

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/prisma ./prisma

USER hypertron
EXPOSE 4001
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "const p=process.env.PORT||4001; fetch('http://127.0.0.1:'+p+'/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
