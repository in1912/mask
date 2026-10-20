# 面具 mask —— Node 22（node:sqlite 需要 >= 22.5）
FROM node:22-bookworm-slim

WORKDIR /app

# 内置规则引擎零依赖；python3 供「外部引擎」可选使用（边车 / engines-setup）。
# 不装 JDK/Go/Maven：Linux 上 engines-setup 也不自动构建这两个命令行引擎，装了也用不上。
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip unzip ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY server ./server
COPY web/dist ./web/dist
COPY python ./python
COPY scripts/start.mjs scripts/engines-setup.mjs ./scripts/
COPY vendor/engines-src/privacy-filter ./vendor/engines-src/privacy-filter

# 外部引擎默认不在启动时装配（数 GB、需联网）；内置规则引擎开箱即用。
# 需要时：docker compose exec mask sh -c "MASK_NO_SETUP=0 node scripts/engines-setup.mjs"
# 并把 python/vendor 与 python/models 挂成卷，否则容器重建会丢。
ENV PORT=9909
ENV MASK_DATA_DIR=/app/data
ENV MASK_NO_SETUP=1

VOLUME /app/data
EXPOSE 9909

CMD ["node", "--no-warnings", "scripts/start.mjs"]
