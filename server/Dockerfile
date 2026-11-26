# Stage 1: Build React/Vite frontend
FROM node:22-alpine AS frontend
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# Stage 2: Build Rust server
FROM rust:1.85-slim AS backend
WORKDIR /app/server
COPY server/Cargo.toml ./
# Cache dependencies
RUN mkdir src && echo "fn main() {}" > src/main.rs && cargo build --release && rm -rf src
COPY server/src ./src
RUN touch src/main.rs && cargo build --release

# Stage 3: Minimal runtime image
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY --from=backend /app/server/target/release/squadvoice-server /app/squadvoice-server
COPY --from=frontend /app/client/dist /app/static

ENV HOST=0.0.0.0
ENV PORT=3001
ENV DATA_DIR=/data
ENV STATIC_DIR=/app/static
ENV MAX_USERS=5

VOLUME ["/data"]
EXPOSE 3001

CMD ["/app/squadvoice-server"]
