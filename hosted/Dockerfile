FROM rust:1.85-bookworm AS reviewer-build

WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked

FROM node:24-bookworm-slim

WORKDIR /app
COPY hosted/server.mjs hosted/dashboard.html hosted/dashboard.css hosted/dashboard.js ./
COPY --from=reviewer-build /build/target/release/second-opinion /usr/local/bin/second-opinion

RUN mkdir /data && chown node:node /data

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    REVIEWER_BINARY=/usr/local/bin/second-opinion \
    HOSTED_STATE_PATH=/data/hosted-state.json

USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
