# openclaw-provider-manager

Web UI 管理 OpenClaw 自定义模型 Provider：**列出 / 添加 / 获取上游模型 / 勾选 / 保存 / 测试连接 / 删除**。

设计约束（已严格遵守）：

- **不直接编辑 `openclaw.json`** —— 所有读写都走 Gateway 的官方 RPC。
- **不挂载 `docker.sock`** —— 管理容器不需要宿主机级权限。
- **不读取 `openclaw.json`** —— 因此拿不到你未主动存入的其他 provider 密钥。
- 独立容器部署，宿主端口 **`:8891`**。

---

## 快速开始（Docker Compose）

不需要克隆仓库，也不需要装 Node：

```bash
# 1. 准备配置
curl -O https://raw.githubusercontent.com/wangliangdong/openclaw-provider-manager/main/docker-compose.yml
curl -O https://raw.githubusercontent.com/wangliangdong/openclaw-provider-manager/main/.env.example
cp .env.example .env

# 2. 填入 Gateway token（必填）
#    在你的 Gateway 主机上执行：openclaw gateway auth-token --show
token=$(openclaw gateway auth-token --show)
sed -i "s|^OPENCLAW_GATEWAY_TOKEN=.*|OPENCLAW_GATEWAY_TOKEN=$token|" .env

# 3. 生成密钥库主密钥（可选，但拿不到它会失去「已存 provider 刷新模型」能力）
key=$(head -c 32 /dev/urandom | base64)
sed -i "s|^PM_VAULT_KEY=.*|PM_VAULT_KEY=$key|" .env

# 4. 启动
docker compose up -d
```

打开 <http://127.0.0.1:8891>。

### 前置条件：必须启用 admin HTTP RPC 插件

本工具**不使用 WebSocket**（原因见第 1 节，跨容器 WS 拿不到 operator 权限）。首次使用前，在 Gateway 主机上启用内置插件并重启：

```bash
openclaw config patch --file <(echo '{"plugins":{"entries":{"admin-http-rpc":{"enabled":true}}}}')
openclaw gateway restart
```

### 网络与端口

| 场景 | 需要改什么 |
|---|---|
| Gateway 在本机 Docker 里，网络名 `openclaw-net` | 默认即可 |
| Gateway 网络名不同 | `.env` 里设 `OPENCLAW_NETWORK=<你的网络名>` |
| Gateway 在宿主机（非容器），Linux | `OPENCLAW_GATEWAY_URL=http://172.17.0.1:18789` |
| Gateway 在宿主机，Docker Desktop | `OPENCLAW_GATEWAY_URL=http://host.docker.internal:18789` |
| 想从局域网访问 | `PM_HOST_BIND=0.0.0.0`（默认仅 `127.0.0.1`，更安全） |

若网络 `openclaw-net` 不存在，Compose 会报错。二选一：把 Gateway 接进该网络，或注释掉 `docker-compose.yml` 里 `networks.openclaw` 的 `external`/`name` 两行，让 Compose 自建。

### 从源码构建（不拉镜像）

```bash
git clone https://github.com/wangliangdong/openclaw-provider-manager.git
cd openclaw-provider-manager
# 注释掉 docker-compose.yml 中的 image:，取消注释 build:
docker compose up -d --build
```

另外也提供 `scripts/deploy.py`（在 **Gateway 容器内**通过 `docker.sock` 触发构建与部署，无需宿主机 shell）——见第 5 节。

---

## 1. 为什么是 HTTP admin RPC，而不是 WebSocket

这一点是本项目最重要的架构结论，**请不要改回 WebSocket**。

OpenClaw 的共享密钥（token）认证在两条传输上授予的权限**完全不同**：

| 连接方式 | 授予的 scopes | `config.patch` |
|---|---|---|
| WebSocket，**loopback** 直连（`ws://127.0.0.1:18789/`） | `operator.read` + `write` + `admin` | ✅ |
| WebSocket，**跨容器**（`ws://openclaw-gateway:18789/`） | **`[]`（空）** | ❌ `missing scope: operator.read` |
| **HTTP admin RPC**，带 `Bearer <token>`（任意来源） | **完整 operator scopes** | ✅ |

即：一个独立容器通过 WebSocket **永远拿不到** operator 权限；而 HTTP admin 端点走的是 HTTP 共享密钥分支（`resolveSharedSecretHttpOperatorScopes` → `CLI_DEFAULT_OPERATOR_SCOPES`），**与来源网络无关**。实测跨容器 `POST /api/v1/admin/rpc` 返回 200。

因此：

```bash
# Gateway 侧启用内置插件（一次性，需重启 Gateway）
openclaw config patch --file <(echo '{"plugins":{"entries":{"admin-http-rpc":{"enabled":true}}}}')
# 重启后生效
openclaw gateway restart
```

该插件把一批方法暴露为 `POST /api/v1/admin/rpc`，**白名单**（`ADMIN_HTTP_RPC_ALLOWED_METHODS`）中与本项目相关的有：

```
config.get  config.schema  config.schema.lookup  config.set  config.patch  config.apply
models.list  models.authStatus
health  status  logs.tail  ...
```

注意：**`models.probe` 不在白名单内**（返回 `admin HTTP RPC method is not supported`）。因此"测试连接"由本工具直接探测上游端点实现（见第 4 节）。

请求/响应：

```jsonc
// POST /api/v1/admin/rpc
// Authorization: Bearer <token>
{ "method": "config.get", "params": {} }
→ { "id": "...", "ok": true,  "payload": { ... } }
→ { "id": "...", "ok": false, "error": { "code": "...", "message": "..." } }
```

---

## 2. `config.patch` 语义（实测，务必遵守）

参数：`{ raw: "<JSON5 字符串>", baseHash?, replacePaths? }`。以下每条都在 2026.9.4 实机复现过：

1. **`baseHash` 必传。** 引入新配置路径（如新增 provider）时不传会报
   `config base hash required for models.providers.<id>...`。hash 来自 `config.get` 的 `payload.hash`（形如 `hmac-sha256:v1:...`）。
2. **陈旧 hash 会被拒绝**：`config changed since last load; re-run config.get and retry`。
   → 本项目在写入前重新读取 hash，并对该错误**自动重试**。
3. **数组是「按下标合并」，不是替换。** 这是最隐蔽的坑：
   把 `models.providers.<id>.models` 从 3 个缩短到 1 个，**调用返回 `ok:true` 但配置没变**（payload 里带 `noop:true`）。
   取消勾选模型（本工具的核心功能）只有在该数组路径出现在 `replacePaths` 时才生效。
   → 本项目**每次写 models 数组都带** `replacePaths: ["models.providers.<id>.models"]`。
4. **删除 provider**（`{...: null}`）在该 provider 拥有 models 数组时会被拒绝，除非同时带上同一个 `replacePaths` 条目。
5. **自定义 provider 必须声明非空 `models` 数组**，否则配置校验失败。
6. `null` 删除路径；标量与数组按上述规则处理。
7. **对象是递归合并的。** 只写 `baseUrl` + `models` 不会动到 provider 级的 `maxTokens`/`timeoutSeconds`/`region`/`headers` 等字段（实测保留）。

### ⚠️ 数组替换会连带丢失 model 级元数据（已修复）

规则 3 的 `replacePaths` 是**整体替换数组**。model 条目除 `id`/`name` 外还有最多 15 个字段：

```
contextWindow  contextTokens  maxTokens  reasoning  input  cost
thinkingLevelMap  params  agentRuntime  headers  compat
mediaInput  metadataSource  api  baseUrl
```

如果编辑器只发送 `{id, name}`，一次保存就会**静默抹掉**这些字段（实机复现：`contextWindow`/`maxTokens`/`reasoning`/`cost`/`headers` 全部消失）。

→ `lib/config-ops.js` 的 `mergeModelEntries` 先读取**已存储**的 models 数组，按 `id` 复用整条原始条目（元数据全保留，包括自定义 `name`），只改变集合成员；只有真正新增的模型才生成 `{id, name}`。`server.js` 在写入前先 `readProvider` 取得 `existingModels` 传入。

**验证依据**：model 级字段（含 `headers.Authorization`）**不会被 `config.get` 脱敏**，所以已存条目可以原样写回。

**密钥保护**：`config.get` 把 provider 级密钥脱敏为 `__OPENCLAW_REDACTED__`。写回行为取决于位置：

| 哨兵值位置 | 结果 |
|---|---|
| 对象合并路径（如 provider 级 `headers.X-Tenant`） | **安全**，服务端视为 no-op，已存值不变 |
| **数组元素内**（如 model 条目） | **硬拒绝 400**：`Reserved redaction sentinel ... is not valid config data` |

`sanitizePatch` 因此在**任何位置**都剥离哨兵，避免触发那类 400。

---

## 3. 模型发现必须由本工具自己实现

**Gateway 不会**为自定义 `openai-completions` provider 枚举上游 `/v1/models`：

- `models.list`（含 `refresh:true`）只返回配置里**已声明**的模型。
- `models.catalogRefresh` 只更新**内置** provider 的元数据。

实测：`example` 配置里声明 2 个模型，上游 `GET https://api.example.com/v1/models` 实际返回 **11 个**。

所以 `lib/discovery.js` 自己做发现：

- OpenAI 兼容：`GET {baseUrl}/models`
- ollama：`GET {baseUrl}/api/tags`

### ⚠️ 已存 provider 无法刷新模型（已由密钥库解决）

`config.get` 永远返回脱敏哨兵，而 Gateway 也没有任何 RPC 能代我们跑发现（已核实源码，非猜测）：

| 方法 | 为何不可用 |
|---|---|
| `models.probe` | **不在** admin HTTP 白名单（白名单是插件里硬编码的 `Set`，无配置项可扩展）；且它只发一次 `maxTokens:8` 的极小推理，返回**鉴权状态/延迟**，**不返回模型列表** |
| `models.catalogRefresh` | 只更新**内置** provider 的目录元数据，不触碰自定义 `openai-completions` 端点 |
| WebSocket 通道 | 跨容器用 token 走 WS 时授权 scope 为空（详见第 1 节） |

于是「刷新一个**已存在** provider 的模型列表」成了一段死路：拿不到明文密钥，就无法请求上游。

**解法**：为选定的 provider 在**本工具自己的加密密钥库**中留一份副本（见第 5 节）。不启用密钥库时，该能力就不可用——这一点在 UI 中是明说的，不会静默失败。

---

## 4. 「测试连接」的诚实语义

`models.list` 的 `available: true` **只表示"配置里声明了"**，不代表可达。
实测：一个指向死端口（`http://127.0.0.1:9/v1`）的 provider，其所有模型仍报告 `available: true`。

因此 `/api/test` **直接探测上游端点**，返回：

| 字段 | 含义 |
|---|---|
| `reachable` | 主机是否应答（连接失败 = false；返回 401 也算 true） |
| `authorized` | 上游是否接受该密钥 |
| `upstreamModels` / `models` | 上游 /models 的模型数 |
| `registered` | Gateway 配置中声明的模型数（仅参考） |
| `keyState` | `provided` / `stored` / `vault` / `redacted` / `missing` |
| `keySource` | 兼容字段：`provided` / `stored` / `hidden`（`hidden` 涵盖 `redacted` 与 `missing`） |
| `authenticated` | 同 `authorized`（语义更明确） |
| `verificationSkipped` | 密钥仅被脱敏因而未做鉴权验证（**非故障**） |

### ⚠️ 401 不等于配置错误（重要）

`config.get` 只会返回 `__OPENCLAW_REDACTED__`，无任何参数可取值明文（`includeSecrets` / `redact:false` 等全部 400，schema 也无开关）。所以**未携带密钥的探测必然拿到 401**，但这并不说明 provider 配错了——网关自己手里有可用的密钥。

因此 `keyState` 必须区分两种情况，它们含义相反：

| `keyState` | 含义 | 应如何呈现 |
|---|---|---|
| `redacted` | **已存**密钥，只是本工具读不到 | 中性（`warn`）：「鉴权：未验证」，**不显示“错误”行** |
| `missing` | **根本未配置**密钥，而上游要求鉴权 | 红色（`error`）：这才是真实的配置缺失 |
| `provided` / `stored` / `vault` | 拿到了明文，探测结果可信 | 正常判定 `authorized` |

前端据此分三种文案；`verificationSkipped` 为真时才弹窗询问密钥以做完整验证。`/api/test` 在 `redacted` 分支会把 `error` 置为 `null`，避免把 401 当作故障上报。

> 这一区分来自真实误报：「localbox」显示红色「鉴权：未通过／API Key 无效或缺失」，而实际它的密钥有效（直连上游返回 200 + 10 个模型），只是被脱敏。

---

## 5. 部署与运行

```bash
# 构建 + 部署（在 gateway 容器内执行，经 /var/run/docker.sock 驱动 Docker Engine API）
python3 scripts/deploy.py up
python3 scripts/deploy.py status     # 状态 + 日志
python3 scripts/deploy.py build      # 仅构建
python3 scripts/deploy.py deploy     # 仅部署
```

容器：`openclaw-provider-manager`，网络 `openclaw-net`，宿主端口 `8891`，以 `node`(uid 1000) 非 root 运行，镜像基于 `node:24-alpine`，**零运行时依赖**。

环境变量：

| 变量 | 说明 |
|---|---|
| `OPENCLAW_GATEWAY_URL` | 默认 `http://openclaw-gateway:18789` |
| `OPENCLAW_GATEWAY_TOKEN` | Gateway token（部署脚本自动从 `openclaw.json` 读取注入） |
| `PM_ADMIN_TOKEN` | 可选；设置后 UI 写入需登录 |
| `PM_PORT` / `PM_BIND` | 默认 `8891` / `0.0.0.0` |
| `PM_VAULT_DIR` | 密钥库密文目录，默认 `/data`（部署脚本设为 `/data`） |
| `PM_VAULT_KEY` | 密钥库主密钥（base64，32 字节）；缺失则密钥库禁用，其余功能不受影响 |

### 加密密钥库

它存在的**唯一目的**是让「已存 provider 刷新模型」成为可能（见第 3 节）。它是 **opt-in** 的：逐个 provider 在编辑弹窗里勾选才保存密钥。

**持久化布局**（关键：密文在挂载目录内，主密钥在挂载目录**外**）：

```
<宿主> /srv/openclaw/config/provider-manager/
├── vault.key          # 主密钥（0600）—— 只经 env 下发，从不挂进容器
└── data/              # 挂载到容器 /data
    └── vault.enc      # AES-256-GCM 密文（0600）
```

这样单独备份 / 同步 `data/` 目录只能得到密文。`deploy.py up` 会自动创建目录并在首次生成主密钥；重建容器不会重新生成，因此已存密钥可持续解密（已验证）。

> ⚠️ **路径翻译不是可选项**：容器创建走 docker.sock，Docker 在**宿主**文件系统解析 bind 源路径。若把只在网关容器内有效的路径（如 `/home/node/.openclaw/...`）直接传进去，Docker 会在宿主上**静默创建空目录**，密钥库看上去正常，直到第一次重建后变空。`deploy.py` 的 `host_path_for()` 通过本容器挂载表做映射，找不到映射时会**明确警告**而不是假装成功。

**安全边界（请诚实对待，不要高估）**：

| 能防 | 不能防 |
|---|---|
| 顺手翻看数据目录 | 本容器被攻破（调用上游时密钥在内存中） |
| 只备份/同步 `data/` | 拿到 Docker / 宿主访问权的人 |
| 误将数据目录纳入 git | `PM_VAULT_KEY` 本身泄露 |

加密细节：AES-256-GCM；随机 12 字节 nonce；**AAD 绑定 provider id**（所以密文无法在 provider 之间调换）；写入走临时文件 + rename（崩溃不会截断）；接口**只写不读**——没有任何 HTTP 路由会返回已存密钥，密文只在调用上游时于内部解密。

#### 从 openclaw.json 导入密钥

每个 provider 都要手动重存一次密钥太磨人。`scripts/import_keys.py` 可以把配置里的明文密钥批量导入：

```bash
python3 scripts/import_keys.py --url http://<manager-ip>:8891 --list      # 看能导哪些
python3 scripts/import_keys.py --url http://<manager-ip>:8891 --dry-run   # 预演，不写入
python3 scripts/import_keys.py --url http://<manager-ip>:8891             # 导入全部
python3 scripts/import_keys.py --url http://<manager-ip>:8891 example localbox # 只导指定
```

**为什么必须由外部脚本做，而不是 manager 自己读配置**：manager 容器**故意不挂载** `openclaw.json`。若挂了，任何能访问 8891 的人（或容器被攻破）就能读到**所有** provider 的明文密钥，而不是仅有你选择存入的那几个——那就把 opt-in 的意义抵消了。所以导入在**网关容器内**运行（配置的正当持有者），只把指定的密钥经只写 API 推过去。

脚本只读 `apiKey` 字段，不碰 `env` 间接引用或 OAuth 材料；**从不打印密钥**，只报长度与结果。

---

## 6. HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/session` | 是否需要登录 / 当前是否已登录 |
| POST | `/api/login` | 提交 `PM_ADMIN_TOKEN`，换取 HMAC 签名 session cookie |
| GET | `/api/status` | Gateway 连通性与延迟 |
| GET | `/api/providers` | 列出 provider（密钥脱敏） |
| POST | `/api/providers` | 新增/更新（`id, baseUrl, api, apiKey?, models[]`） |
| DELETE | `/api/providers/:id` | 删除（不存在返回 404） |
| POST | `/api/discover` | 上游模型发现（`baseUrl, api, apiKey?, providerId?`）；密钥按 `provided → 配置 → 密钥库` 回退 |
| POST | `/api/test` | 连接测试（见第 4 节） |
| GET | `/api/vault` | 密钥库元数据（仅 id/时间戳，**不含密钥**） |
| POST | `/api/vault` | 存入/更新密钥（`id, apiKey`）；服务端加密后落盘 |
| DELETE | `/api/vault/:id` | 移除该 provider 的密钥（不存在返回 404） |

`apiKey` 留空 = **保留已存密钥**（patch 中不包含该字段）。

**密钥解析优先级**（`/api/discover`、`/api/test` 一致）：本次输入 > `config.get` 明文（今日不可达，但保留以应对网关未来不再脱敏） > 密钥库。返回的 `keySource`/`keyState` 即使**失败也会带上**，因为「密钥库里的密钥被拒」（需重存）与「压根没有密钥」（需启用密钥库）需要相反的处置。

---

## 7. 测试

```bash
node --test test/*.test.js     # 或 npm test
```

50 个用例，覆盖：

- `config-ops`：ID 校验、patch 构造、**`replacePaths` 必带**、**model 元数据按 id 合并保留**、密钥保留、哨兵剥离、脱敏、陈旧 hash / noop 识别。
- `discovery`：baseUrl 归一化、OpenAI/ollama 端点、401/非 JSON 错误分类、`probeProvider` 的 reachable/authorized 判定。
- `keystore`：加解密往返、**改密文被 GCM 标签发现**、**跨 provider 调换密文被 AAD 发现**、换主密钥后报错而非静默失败、并发写不丢条目、文件权限 0600、损坏/版本不符上报而不当空处理。

端到端（真实 Gateway + 真实上游）已在部署后验证：读取、创建、**数组缩短 3→1**、增长、编辑时密钥保留、**编辑时 model 元数据保留**、校验拒绝、11 模型发现、死端点诚实报告、删除、删除不存在返回 404。

### 前端浏览器测试（必需，不可省略）

```bash
PY=/home/node/workspace/.venvs/web/bin/python
$PY scripts/check_ui.py   http://192.0.2.10:8891   # 渲染 + JS 异常
$PY scripts/check_flow.py http://192.0.2.10:8891   # 交互流程 30 项
```

**为什么必须跑**：曾经只靠 curl 打 API 验证，结果一个前端变量遮蔽 bug（`setGwStatus` 内 `const el = …` 遮蔽了全局 `el()` 辅助函数）导致页面渲染空白、列表永远为空，而**所有 API 层检查全部通过**。前端代码只能放在真浏览器里验。

`check_flow.py` 会启一个**要求鉴权的** mock 上游（缺少 `Authorization: Bearer` 则返回 401），覆盖：新增 → 发现（成功 + 失败）→ 手动加模型 → 保存 → 编辑回填 → **测试连接（密钥被脱敏 → warn、手输密钥 → ok）** → **密钥库（勾选保存 → 刷新模型不再重输密钥 → 测试连接走密钥库 → 移除后回退）** → 删除，并断言 JS 零未捕获异常。

> 密钥库那组用例在服务未配置 `PM_VAULT_KEY` 时会明确报失败，而不是静默跳过——以免「测试全绿」掩盖一个未启用的特性。

> 跨容器测试：manager 在另一容器时，mock 上游必须绑定到**对方可访问的 IP**（本容器在 `openclaw-net` 的地址），不能用 `127.0.0.1`：
> ```bash
> $PY scripts/check_flow.py http://172.20.0.10:8891 172.20.0.11 172.20.0.11
> #                              ^manager            ^mock 绑定       ^mock 对外通告
> ```

---

## 8. 目录结构

```
server.js              零依赖 Node HTTP 服务 + 路由 + HMAC session
lib/gateway.js         Gateway admin HTTP RPC 客户端
lib/config-ops.js      config.patch 构造 / 脱敏 / 校验（纯函数，已测）
lib/discovery.js       上游模型发现 + 连接探测
lib/keystore.js        AES-256-GCM 加密密钥库（只写不读，已测）
public/                前端（中文 UI）
scripts/dk.py          Docker Engine API 客户端（stdlib）
scripts/deploy.py      内存 tar 构建 + 容器部署
scripts/import_keys.py 从 openclaw.json 批量导入密钥（在网关容器内运行）
scripts/check_ui.py    浏览器渲染检查（playwright）
scripts/check_flow.py  浏览器交互流程检查 + 本地 mock 上游
test/                  单元测试
```
