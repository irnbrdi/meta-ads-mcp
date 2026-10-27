FROM node:18-alpine

WORKDIR /app

# Install all deps (incl. dev) so TypeScript can compile inside the image.
COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm@10 && pnpm install --no-frozen-lockfile

# Build from source.
COPY tsconfig.json ./
COPY src/ ./src/
RUN pnpm run build

# Drop dev dependencies to keep the runtime image small.
RUN pnpm prune --prod

ENV PORT=8000
EXPOSE 8000

CMD ["node", "dist/http.js"]
