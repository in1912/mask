# 面具 mask —— Node 22（node:sqlite 需要 >= 22.5）
# 多阶段：镜像内构建 godlp（Go）与 sensitive-word（Java 17），开箱即用两个命令行引擎；
# Python 引擎（Presidio/GLiNER/OPF/argus/scrubadub）体积数 GB，仍按需装配（见 docker-compose.yml）。

# ---------- 构建阶段 1：godlp CLI（静态二进制，不依赖运行时 Go） ----------
FROM golang:1.23-bookworm AS godlp
WORKDIR /src
COPY vendor/godlp-cli ./vendor/godlp-cli
COPY vendor/engines-src/godlp ./vendor/engines-src/godlp
RUN cd vendor/godlp-cli \
 && CGO_ENABLED=0 GOFLAGS=-mod=mod GOPROXY=https://goproxy.cn,direct GOSUMDB=off \
    go build -trimpath -ldflags '-s -w' -o /out/godlp-cli .

# ---------- 构建阶段 2：sensitive-word CLI（release 17，运行镜像用 JRE 17） ----------
FROM maven:3.9-eclipse-temurin-17 AS sensitive-word
WORKDIR /src
COPY vendor/sensitive-word-workspace ./vendor/sensitive-word-workspace
# 阿里云镜像：Maven Central 在国内直连经常超时
RUN mkdir -p /root/.m2 /src/vendor/sensitive-word \
 && printf '%s\n' '<settings><mirrors><mirror><id>aliyun</id><mirrorOf>central</mirrorOf><url>https://maven.aliyun.com/repository/public</url></mirror></mirrors></settings>' > /root/.m2/settings.xml \
 && cd vendor/sensitive-word-workspace \
 && mvn -B -q -Dmaven.repo.local=/root/.m2/repository package

# ---------- 运行镜像 ----------
FROM node:22-bookworm-slim

WORKDIR /app

# python3 供「Python 引擎」可选使用；default-jre-headless 运行 sensitive-word（jar 是 release 17）
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip unzip ca-certificates default-jre-headless \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY server ./server
COPY web/dist ./web/dist
COPY python ./python
COPY scripts/start.mjs scripts/engines-setup.mjs ./scripts/
COPY vendor/engines-src/privacy-filter ./vendor/engines-src/privacy-filter

# 两个命令行引擎：默认命令本来就指向 vendor/ 下这两个路径（server/engines/index.js），
# 镜像里放好即可用，无需改设置。java 做软链到系统 JRE。
COPY --from=godlp /out/godlp-cli ./vendor/godlp/godlp-cli
COPY --from=sensitive-word /src/vendor/sensitive-word/sensitive-word-cli.jar ./vendor/sensitive-word/sensitive-word-cli.jar
RUN chmod +x ./vendor/godlp/godlp-cli \
 && mkdir -p ./vendor/jdk/bin \
 && ln -sf /usr/bin/java ./vendor/jdk/bin/java

# Python 引擎默认不在启动时装配（数 GB、需联网）；内置规则引擎 + godlp + sensitive-word 开箱即用。
# 需要时：docker compose exec mask node scripts/engines-setup.mjs
# 并把 python/vendor 与 python/models 挂成卷，否则容器重建会丢。
ENV PORT=9909
ENV MASK_DATA_DIR=/app/data
ENV MASK_NO_SETUP=1

VOLUME /app/data
EXPOSE 9909

CMD ["node", "--no-warnings", "scripts/start.mjs"]
