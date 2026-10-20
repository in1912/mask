# 面具 mask · AI 脱敏系统

把要发给外部 AI 的内容先在你的机器上替换成占位码，AI 只见到码文；回复流式到达时按对照表自动复原。原文与对照表**永远不离开本机**。

```
你 → [面具: 规则引擎本地替换] → 占位码 → 外部 AI（OpenAI 兼容）
你 ← [面具: 对照表流式复原] ← 码文回复 ←──────────────┘
```

## 架构

- **单进程**：Express + `node:sqlite`（Node ≥ 22.5 自带，零原生依赖），端口 **9909**
- **前端**：Vue3 + Vite（hash 路由），四主题（夜/昼/莫兰迪紫/莫兰迪绿），60px 图标收缩侧栏，H5 自适应
- **数据**：全部落在 `data/mask.sqlite` 一个文件（会话、对照表、日志、配置）；API Key 与登录尝试密码 AES-256-GCM 加密存储
- **引擎**：纯规则（正则/锚定/校验/词典/启发式），识别阶段不调 AI、不联网

## 快速开始

**最简单**：双击项目根目录的 `启动.cmd`（首次会自动装依赖/构建前端，然后起服务并打开浏览器）。

**命令行方式**：

```bash
# 服务端（Node ≥ 22.5）
npm install
npm run build:web     # 构建前端（web/ 目录 npm install + vite build）
npm start             # http://127.0.0.1:9909

# 开发模式（另开终端，前端热更新走 9910）
cd web && npm run dev
```

首次启动空库自动创建管理员 `aiadmin / admin123`（仅空库首启生效，请立刻改密）。**登录后先去「系统设置 → AI 配置」填外部 AI 的接口地址、模型与 API Key（可先点「测试连接」），否则对话会返回 503「AI 接口未配置」。**

## 三端分发包

```bash
npm run pack:dist      # 产物在仓库根目录（*.zip 已在 .gitignore，不入库）
```

| 包 | 内容 | 启动 |
|---|---|---|
| `面具-<版本>-windows.zip` | server / web 构建 / 生产 node_modules / Python 边车源码 / 引擎源码骨架 | 解压后双击 `start.bat` |
| `面具-<版本>-macos.zip` | 同上（macOS 版启动器） | `chmod +x start.command` 后双击 |
| `面具-<版本>-docker.zip` | server / web 构建 / Dockerfile / docker-compose.yml | `docker compose up -d --build` |

三个包都**不含任何个人数据**：`data/` 是空目录，首次启动自动建库（默认管理员 `aiadmin / admin123`，登录后请立刻改）。`Logs/`、`web/src/`、旧的前端构建、`python/vendor`、`python/models`、JDK/Go/Maven 运行时都不进包。

**外部引擎**：内置规则引擎开箱即用。Windows 包首次启动会装配 Python 引擎并自动下载 JDK/Go/Maven 构建 godlp、sensitive-word；Linux（含 Docker）同样支持自动下载与构建，但默认 `MASK_NO_SETUP=1`，由管理员在**设置 → 引擎 → 外部引擎依赖**里点按钮按需安装；macOS 包只装配 Python 引擎（godlp/sensitive-word 的自动构建目前按 Windows/Linux 编写，macOS 未实机验证）。装配需要联网、体积数百 MB 到数 GB，失败不拦主服务，设置 → 引擎里如实报哪个不可用。

**Docker 里装的东西会跟着容器走**：在线安装落在 `/app/vendor`、`/app/python`，容器重建就没了。要长期保留，把输出目录挂成宿主机卷（不要整目录挂 `vendor/`——那会盖掉镜像里的引擎源码）：

```yaml
volumes:
  - ./data:/app/data
  - ./vendor/jdk:/app/vendor/jdk
  - ./vendor/go:/app/vendor/go
  - ./vendor/maven:/app/vendor/maven
  - ./vendor/maven-repo:/app/vendor/maven-repo
  - ./vendor/dl:/app/vendor/dl
  - ./vendor/godlp:/app/vendor/godlp
  - ./vendor/sensitive-word:/app/vendor/sensitive-word
  - ./python/vendor:/app/python/vendor
  - ./python/models:/app/python/models
```

v0.4.1+ 镜像已内置 godlp 与 sensitive-word，不需要再装命令行引擎；Python 引擎仍按需装。

**Docker 镜像里内置了什么**：v0.4.1 起 Dockerfile 用多阶段构建，镜像内直接带好 **godlp**（Go 静态二进制）与 **sensitive-word**（Maven 打出的 jar + JRE 17 软链），两个命令行引擎开箱即用，默认命令本来就指向 `vendor/` 下这两个路径，无需改设置。Python 引擎仍按需装配（数 GB）。

**验证边界**：Windows 包已解压实测（health / 版本 / 入口 chunk / 匿名 `/api/batch` 401）；Docker 包按 Dockerfile 的文件集合 `npm ci --omit=dev` 后同样跑通，构建阶段的 godlp Linux 二进制已交叉编译验证、sensitive-word jar 已在本机构建；开发机没有 Docker，**镜像本身未实际构建**。

## 功能（v0.4.3）

| 菜单 | 说明 |
|---|---|
| 数据脱敏 | 左会话列表（默认载入最近会话）/ 中聊天气泡 / 右说明·当前规则·本轮对照面板；回车发送、Ctrl+回车强制脱敏发送；附件（txt/docx/pdf/xlsx）上传自动提取文本合并脱敏 |
| 文件脱敏 | 上传 txt/docx/pdf/xlsx（≤20MB，零依赖提取正文，天然剥离文档元数据）→ 三栏拖拽预览（原文｜脱敏｜外部 AI 返回）；文档级持久对照（重复执行同实体同码）；下载 原文/脱敏/回文；分享链接只含码文，1/7 天自动失效，成对生成回文地址，外部回文按对照表自动复原到你的文档里 |
| 批量脱敏 | 一次上传最多 50 个 txt/docx/pdf/xlsx，或勾选若干会话一键生成批次 → 后台逐文件脱敏 → 整批共用一张对照表（同一实体跨文件同码）→ 逐文件查看/下载、整包 zip（脱敏文本 + mapping.csv + 失败清单）；原文件保留可下载，批次不自动清理；管理员可见全部批次与全部用户历史 |
| Agent协同 | 给外部 AI 的只写地址：默认永久（可 7/14/30 天），对方只能看引导语并提交回文（≤2MB），写入内容只有你能看到；点行展开回文列表（5/15/30/50/100 条/页）与 Markdown 渲染 |
| 规则配置 | 四大类约 45 条规则逐条开关；编码风格三选（A `[公司A7]` 混合语义码默认 / B `[公司1]` 序号 / C `ORG-7K2M9` 随机码）；裸数字/语境金额独立开关（含「数字脱敏对 AI 算术的影响」常驻说明）；固定关键词；试运行 |
| 脱敏历史 | 时间/来源/用户/项数，点击展开对照表快照与脱敏后文本；二次复核（残留代码/未引用项）；默认 10 条可切 10/20/30/50/100 |
| 脱敏原理 | 静态说明 |
| 用户管理 | 独立用户库（管理员）：创建/重置密码/停用/解锁/删除；文档与 Agent 链接按用户隔离（管理员可见全部） |
| 系统设置 | 登录日志（三态、地区、尝试的密码加密、客户端、一键封禁 IP，默认 5 条可切 5/15/30/50/100）；IP 黑名单（全站第一道闸）；AI 配置（OpenAI 兼容 + 测试连接）；**引擎**（多引擎切换 + **一键安装外部引擎依赖**，见下）；**致谢**（引用的开源引擎及本机可用状态）；**升级**（上传 zip 在线升级）；**HTTPS 证书**（自签名，同端口双协议）；系统信息（ICP 备案文案留空则登录页不显示） |

**安全语义**：同一会话内同一实体始终同码（AI 上下文连贯）；上行自动注入「占位符保留」系统指令；总开关关闭时如实提示未脱敏，绝不假装；同 IP 5 分钟 8 次、同账号 15 分钟 5 次失败临时拦截、10 次永久锁定。

### 人名识别（v0.3.0 加强）

起因是一份例会纪要：`温培泉、刘立伟、刘艺彬(请假)` 全漏，`上周工作` 被误报成「周工」。现在人名走四条路，**强证据（列表/锚定/引号）全篇传播**：

- **姓名列表**：顿号/逗号分隔的 2~4 字姓名串（姓氏表约 200 个，含括注如 `(请假)`）
- **角色锚定**：`参会人员：/主持人：/责任人：` 等锚点后的姓名（排版空格 `主 持 人：` 也认）
- **称谓**：`王总/周工/Li工` 类姓氏+称谓（带防误报词典：`上周工作/关于工资/张总共` 不咬）
- **引号**：中文引号包裹的 2~4 字姓名

### 批量脱敏（v0.4.0）

入口：左侧「批量脱敏」。适合把一批会议纪要、往来邮件、表格导出一次性处理完，再整包交给外部 AI 或第三方。

- **两种建批次方式**：多选上传本地文件（≤50 个，单个 ≤20MB，合计 ≤200MB）；或「从会话生成批次」，每个会话导成一个 txt 再一起脱敏。
- **后台执行、失败不拦整批**：一次只跑一个批次，逐文件处理；某个文件坏了（例如扫描件 PDF 提不出字、docx 结构损坏）只在它自己那行报原因，其余文件照常完成。修好文件可以重跑，只补失败的文件，成功的不重复处理。
- **整批一张对照表**：同一手机号/公司名/人名在所有文件里始终同一个占位码，zip 与页面上的对照表一致。前几个文件确认过的实体还会作为候选补进后面的文件——第二份文件里孤立出现的「张三」也能认出来并沿用同码。
- **输出是纯文本 `.txt`**：不保留 Word/PDF/Excel 排版、图片与表格样式；这是为了脱敏结果可被任意工具安全消费。
- **原文件不删**：批次详情里每个文件都能「查看」（原文与脱敏后并排）、「原文」下载、「脱敏」下载；整个批次可下载 zip（`masked/` + `mapping.csv`（带 BOM，Excel 直接开）+ `_errors.txt`）。删除整个批次才会连磁盘文件与对照一起清掉，脱敏历史仍然保留。
- **批次不自动过期/清理**：文件一直留在 `data/batches/<批次>/`，要回收磁盘请自行删除批次。
- **权限**：普通用户只能看到自己的批次；管理员可以看到全部批次、全部用户的历史与内容（用户 2026-10-20 拍板）。
- 中文文件名按 UTF-8 解析（上传曾经因 busboy 按 latin1 解码而乱码，已修；历史单据在启动时幂等修复一次）。

### 多引擎切换（v0.3.2：引擎与依赖随项目走）

内置规则引擎之外可接入外部本地引擎，设置 → 引擎 里配置**主引擎（单选，内置让位）**或**并行使用（并集去重）**。所有引擎都在本机跑，原文不出网；全部外部引擎都进「致谢」页（引用即致谢），探测状态只作附加信息。

**首次启动自动装配**：`npm start` / `启动.cmd` 会先跑安装器——把 Python 依赖装进 `python/vendor/`、模型预取到 `python/models/`、JDK/Go/Maven 解压到 `vendor/`、编译 godlp CLI 与 sensitive-word jar。检查是幂等的：装好后每次启动只做存在性检查，秒过且完全离线。装配失败不拦主服务，缺哪个引擎就在探测页如实报哪个。

**网页里一键装依赖（v0.4.2 起，v0.4.3 修跨设备搬家）**：设置 → 引擎 → **外部引擎依赖**，三个按钮：
- **安装命令行引擎**：下载 JDK + Go + Maven，现场编译 godlp 与 sensitive-word（约 500MB~1GB，通常 5~15 分钟）；
- **安装 Python 引擎**：pip 依赖 + GLiNER/OPF 模型（数 GB）；
- **全部安装**：两者都装。

点下去后日志实时显示（同时写 `Logs/engines-setup-<时间戳>.log`），同一时刻只允许一个安装任务（再点回 409）。Docker 镜像默认 `MASK_NO_SETUP=1`，这个按钮就是为「不想重建镜像、但要用命令行引擎」准备的；安装结果在容器内，重建会丢（持久化卷配置见上文「三端分发包」）。安装器本体在 `server/services/enginesInstaller.js`（放在 `server/` 下才能随在线升级包一起升上去），`scripts/engines-setup.mjs` 与 `npm run setup:engines` 只是命令行入口，参数一致。

平台边界（如实说）：Windows x64 与 Linux x64/arm64 会自动下载并构建命令行引擎；macOS 目前只装 Python 引擎。Linux 构建已按 Docker 的目录布局在本机等价复跑（godlp 静态 ELF、sensitive-word jar）。

**v0.4.3 修了两个只在生产真装时才暴露的问题**：①解出的 JDK/Go/Maven 被搬到项目根（`/app/jdk`）而不是 `vendor/` 下，装完永远探测不到——这是 v0.3.2 起就存在、本机因 `vendor/` 早已存在而从未走到的分支；②Docker 里把 `vendor/` 挂成宿主机卷时，从镜像层 `rename` 到挂载卷会 `EXDEV: cross-device link`，现在自动退回复制，挂载点本身删不掉时改为清空内容。另外，预检原先要求包内前端目录**严格比现役新**，纯服务端升级（前端没重构建、dist 同名）会被误判为「白升」拒收；v0.4.3 改为**允许相等、只拒绝更旧**，落盘时同名文件按内容跳过。下载请求补了 User-Agent（Adoptium 对无 UA 请求回 403），Linux JDK 多一个清华镜像兜底。**开发机仍没有 Docker，修复后没有在真容器里把整个按钮流程重跑一遍**——生产那次的实测证据只到「JDK 下载成功、搬移报 EXDEV」。

| 引擎 | 接入方式 | 说明 |
|---|---|---|
| godlp（字节跳动） | 命令行 | Go 脱敏 SDK；项目内 `vendor/godlp-cli` 是 stdin→实体 JSON 的包装，首次启动自动编译 |
| sensitive-word（houbb） | 命令行 | Java 中文敏感词库；项目自带 JDK 21 与 CLI 包装，首次启动自动构建 jar |
| Presidio（微软） | Python 边车 | 依赖装在项目内 `python/vendor`；NoOp NLP + 中文手机号/身份证/银行卡自定义识别器，不下载 spaCy 模型 |
| GLiNER-PII（knowledgator） | Python 边车 | `urchade/gliner_multi_pii-v1`（约 1.1GB）已预取；中文按字符切词，纯本地推理 |
| argus-redact | Python 边车 | fast 档（本地正则+词表，不联网），实体坐标来自 `RedactReport.entities` |
| scrubadub | Python 边车 | 邮箱/URL/信用卡等规则识别；中文紧贴英文时依赖标点边界，可能漏报 |
| OpenAI Privacy Filter | Python 边车 | 1.5B MoE token 分类模型，CPU 本地推理，模型约 2.8GB；首次加载较慢 |

**边车是什么**：Python 引擎（Presidio / GLiNER / argus / scrubadub / OPF）没法在 Node 里跑，所以由一个独立的 `python/sidecar.py` 进程承载，只监听本机回环地址（默认 9812）。模型加载一次常驻内存，主服务每次识别走本机 HTTP 问它；原文不出机器。主服务启动时发现本机没有边车会自动拉起，用户一般不用手管。

`D:\脱敏` 里的 12 个项目，**3 个能直接用于文本**（Presidio、scrubadub、privacy-filter→OpenAI Privacy Filter），其余 9 个是数据库/大数据/统计类工具，设置页排在文本引擎之后，标注**「不参与文本识别」**——它们产出的是整表/整库的脱敏数据，不是文本里的实体坐标，因此不能当主引擎，也不会被探测。各自什么时候用得上：

| 工具 | 场景 |
|---|---|
| CloakDB | 给测试环境造脱敏数据库：直接吃 SQL 导出/CSV/Parquet，外键与校验位仍对得上 |
| ShardingSphere | 线上数据库中间件层统一加密/脱敏，应用不改代码 |
| postgresql_anonymizer | PostgreSQL 整库脱敏：建匿名化视图，导出或给第三方前整库替换 |
| pg_anonymize | 生产→测试的逻辑复制链路上顺手脱敏 |
| Apache Ranger | Hive/HDFS 集群按用户/角色配脱敏策略 |
| ARX | 对外发布统计表格前做 k-匿名/l-多样性/差分隐私 |
| sdcMicro | R 环境下统计调查微观数据的披露控制 |
| Jailer | 从生产库按外键关系抽测试子集并脱敏 |
| anonimatron | 任意 JDBC 数据库一次性字段清洗（YAML 配置列规则） |

外部引擎实体类型自动映射到内置规则（PERSON→person…），映射不到的用 `EXT` 码；坐标对不上按实体内容重定位（Python 码点 vs JS UTF-16 单元天然有偏差）。引擎失败**如实报 502**，绝不静默降级假装脱敏成功。

**边车地址**默认 `http://127.0.0.1:9812`。主服务启动时发现本机地址上没有边车，会自己拉起 `python/sidecar.py`（`MASK_NO_SIDECAR=1` 可关闭）。**不要填本系统自己的 9909**——那会把本系统的网页当成边车，探测只会报「响应异常（HTTP 200）」；保存时会被直接拦下，历史遗留的 9909 配置读取时自动回落 9812。

**命令行引擎报错**：先按 `PATH`/`PATHEXT` 自己找程序，找不到直接给中文提示（例：`找不到可执行程序「java」…需要先装 JDK/JRE 8+`），不再把 cmd.exe 的 GBK 原始报错甩给用户；Windows 下子进程先 `chcp 65001`，仍有乱码按 GBK 兜底解码。

### 在线升级（v0.3.0，承游巷方案）

设置 → 升级 上传升级包（`npm run pack:upgrade` 打包）：只读预检（路径白名单/逐文件 sha256/server js 编译验证/依赖变化检测）→ 一次性 token 应用（两阶段落盘 + 自动备份 `data/upgrades/backup_<时间戳>/` 可下载回滚）→ 老进程退出、detached 子进程抢回端口自我接替。只换前端的包不重启即生效。升级包绝不写 `data/`。

### 自签 HTTPS（v0.3.0，承教材方案）

设置 → HTTPS 证书 生成自签名证书（零依赖手写 ASN.1 DER，SAN 自动附赠 localhost/127.0.0.1，上限 825 天），重启后**同一端口**同时提供 HTTP 与 HTTPS（TCP 首字节 0x16 嗅探分流）；也支持上传外部工具生成的证书对（公钥匹配校验）。旧证书自动备份。

## 自检

```bash
npm run check
# engine 54 + server 39 + chat 26 + files 59 + batch 55 + upgrade 62 + ssl 16 + engines 45 + setup 21 = 377 项
node scripts/verify-upgrade-restart.mjs   # 升级→自我接替→新版真在跑（唯一覆盖重启链路的脚本）
```

`check-chat` / `check-files` 用桩 AI 做泄漏断言：桩收到的请求体与分享页 HTML 里**不允许出现**手机号/公司名/金额明文；流式增量拼接必须与最终复原文本逐字节一致（半码不外泄）；匿名回文者拿不回复原结果；过期/撤销/删除的链接即刻 410/404。`check-engines` 起真边车 + stdio mock 验证多引擎全链路（含主引擎失败 502、并行去重、坐标重定位）。`check-setup` 用临时 mock 脚本验证「一键安装依赖」的权限、scope 白名单、单任务互斥、日志采集、成功/失败退出码与日志落盘——**自检绝不联网下载真实依赖**。

## 诚实边界（当前版本）

- 人名、地址、公司名是启发式识别，仍可能漏报/误报（四路识别后例会纪要类文档已基本覆盖）；关键实体请加进「固定关键词」
- 数字一旦脱敏，AI 无法做算术、统计、比较
- 附件支持 txt/docx/pdf/xlsx；老格式 .doc/.xls 如实拒收并提示另存；**图片明确拒收**（内容本身送出去就是明文）；扫描件 PDF 提取不到文字时如实报错
- PDF 提取依赖内嵌字体 ToUnicode 映射，无映射的内嵌字体不受支持
- 文档级对照表与文档同库同机，删除文档即连带删除对照与回文；分享页只有码文、绝无原文
- 批量脱敏输出只有 `.txt`：排版、图片、表格样式不保留；批次文件不会自动清理，磁盘自己管 [删除批次]
- 批量的人名识别依赖上下文或同批已确认实体：全新批次里孤立出现、又没有「联系人：」这类锚点的姓名仍可能漏（可把姓名加进「固定关键词」，或在第一份文件里带语境出现一次）
- 外部引擎依赖随项目走，但**首次装配需要联网**（PyPI + hf-mirror + goproxy.cn + Maven Central）：Python 包约 1.3GB、模型约 3.7GB、JDK/Go/Maven 约 600MB。装好后可离线启动。装配失败时主服务照常，探测页如实说哪个引擎不可用。**云端 NER API 一律不接**——原文不出本机是红线
- 「一键安装依赖」按钮在 Windows 路径已本机验证（已装好时全部跳过）；Linux 的下载/解压/编译逻辑已按 Docker 目录布局等价复跑，但**没有在真容器里点过完整流程**，首次在线上安装请预留十几分钟并看实时日志。Docker 里装的东西不挂卷就会随容器重建丢失
- 各引擎能力有差异：godlp 擅长结构化 PII（手机号/邮箱/身份证），sensitive-word 是敏感词库而非 PII 识别，Presidio 的中文人名/地址靠英文规则+自定义正则（人名弱），GLiNER-PII 用字符级切词（召回高但阈值需按语料调），scrubadub 在中文紧贴英文时可能漏报，OPF 首次加载慢且占内存
- `D:\脱敏` 的 9 个数据库/统计类工具只做登记与致谢，不参与文本脱敏管线
- 升级不删旧文件、不更新 node_modules（依赖变化被预检拦下要求人工确认）；备份保留份数可配
- Docker、EXIF 剥离在后续版本；截图待 v1.0.0 发版时补入 `img/`

## 环境变量

| 变量 | 作用 |
|---|---|
| `PORT` | 监听端口（默认 9909；被占用重试 2 次后退出） |
| `MASK_DATA_DIR` | 数据目录（默认 `./data`） |
| `MASK_ADMIN` / `MASK_ADMIN_PASSWORD` | 空库首启的管理员账号（默认 aiadmin/admin123） |
| `MASK_SECRET` | AES 密钥种子（默认随机落盘 `data/secret.key`，换了它旧密文解不开） |
| `MASK_GEO=off` | 关闭登录地区在线查询（ip-api.com） |
| `MASK_UPGRADE_ROOT` / `MASK_WEB_ROOT` | 升级写入根 / 前端目录（自检指向临时副本） |
| `MASK_NO_RESTART=1` | 自检模式：升级/换证书只落盘不重启 |
| `MASK_UPGRADE_MAX_MB` | 升级包体积上限（默认 300MB） |
| `MASK_RESTART_CHILD=1` | 接替子进程自标识（勿手工设置） |
| `MASK_GLINER_MODEL` / `MASK_GLINER_THRESHOLD` | GLiNER-PII 模型目录与阈值（默认 `python/models/gliner_multi_pii-v1`、0.4） |
| `MASK_PYTHON` | 装配/边车使用的 Python 命令（默认 Windows `python`，其他 `python3`） |
| `MASK_ENGINE_SETUP_LOG_DIR` | 「一键安装依赖」日志目录（默认 `Logs/`；自检指向临时目录） |
| `MASK_ENGINES_SETUP_SCRIPT` | 安装器路径覆盖（自检用，勿在生产手工设置） |
| `MASK_NO_SIDECAR=1` | 不自动拉起边车（自检脚本用；手动管理边车时也可用） |
| `MASK_NO_SETUP=1` | 启动时跳过引擎装配检查（已装好且想快速启动时用） |
