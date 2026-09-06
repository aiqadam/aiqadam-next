# syntax=docker/dockerfile:1.7
# Multi-stage build for the aiqadam-next Next.js 16 app (App Router, npm workspaces).
FROM node:22.14.0-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json ./apps/web/package.json
RUN npm ci
COPY . .
RUN npm run build

FROM node:22.14.0-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
COPY --from=builder /app/apps/web/public ./apps/web/public
COPY --from=builder /app/apps/web/.next ./apps/web/.next
COPY --from=builder /app/apps/web/package.json ./apps/web/package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
EXPOSE 3000
USER node
CMD ["npm", "start"]
