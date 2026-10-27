# dsh-a2a-bridge 安全配置指南

本文面向**任何**要部署本插件的 DSH 用户，讲清楚三件事：

1. 怎么生成和存放 token（配置里只写引用名，不写值）
2. 怎么让局域网内的对端访问到你，同时不把端口暴露给所有人
3. 明文 HTTP 的真实风险，以及什么时候必须升级到 TLS / 加密覆盖网络

> 本文只讲**怎么配**；威胁建模与每条风险的处置理由见 [`threat-model.md`](threat-model.md)。
> 文中出现的 IP、路径、端口都是**示例值**，请替换为你自己的。

---

## 0. 一页速查

| 你要做的事 | 关键点 |
|---|---|
| 生成 token | 32 字节随机，编码成 base64url 或 hex |
| 存放 token | 存进 DSH 的凭据层（`ctx.credentials` 引用名），**配置里只写名字** |
| 谁能访问我 | `inbound.peers` 声明对端 + 各自 token 引用名 |
| 我能访问谁 | `outbound.contacts` 声明对端 URL + token 引用名 |
| 监听地址 | 必须是**本机一个具体地址**，通配（`0.0.0.0` / `::` / `*`）会**拒绝启动** |
| 防火墙 | 只对**对端地址**放行 A2A 端口，且只在 Private/内网网络配置文件下 |
| 轮换 token | 凭据每请求重新解析，改完**下一个请求**即生效，不用重启 |
| 什么时候必须上加密 | 局域网内出现你不控制的设备，或需要跨网段访问时 |

---

## 1. 生成 token

### 1.1 要求（硬性）

- **至少 32 字节随机**——不是口令、不是 UUID、不要自己编
- 只用 URL 安全字符（base64url 或 hex），避免在 HTTP 头里出问题
- **每个对端一枚独立 token**：共享一枚等于任何一台被攻破后全网通行
- 不要复用你在别处用过的密钥

### 1.2 生成命令（任选其一）

```bash
# ① Node（装了 DSH 的机器一定有）
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"

# ② OpenSSL
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='

# ③ PowerShell（Windows）
[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).Replace('+','-').Replace('/','_').TrimEnd('=')
```

### 1.3 命名与归属（先定名，再生 token）

token 在配置里以**引用名**出现，所以先想清楚名字，避免两枚 token 互相覆盖：

```yaml
inbound:
  peers:
    peer-b:                       # 对端标识（会进入路径，只能用 [A-Za-z0-9_-]）
      tokenEnv: A2A_TOKEN_PEER_B  # 引用名，必须是合法环境变量名
```

规则：

- **对端标识**与**引用名**是两件事：前者是"谁"，后者是"去哪取密钥"
- 引用名必须匹配 `^[A-Za-z_][A-Za-z0-9_]*$`；把真实 token 值写在这里会在**加载期被拒绝**
- `inbound.peers`（谁能进）与 `outbound.contacts`（我能出）刻意不共用词表——
  同名是最容易埋的坑

---

## 2. 配置：只存引用名，不存值

### 2.1 服务端（谁能访问我）

```yaml
inbound:
  enabled: true
  peers:
    peer-b:
      tokenEnv: A2A_TOKEN_PEER_B
  trustedPeers: [peer-b]        # 认证之上再叠一层白名单；空 = 已声明的全部
  listen:
    host: 192.168.1.10          # 本机一个具体地址；通配会被拒绝
    port: 3081
  isolation:
    workspaceMode: per-peer     # 每个对端独立工作目录 = 防跨对端读文件
```

### 2.2 客户端（我能访问谁）

```yaml
outbound:
  enabled: true
  contacts:
    - name: peer-b
      url: http://192.168.1.11:3081/a2a
      agentCardPath: /.well-known/agent-card.json
      tokenEnv: A2A_TOKEN_PEER_B   # 访问对端所用的引用名
      timeoutMs: 300000
```

### 2.3 值的存放位置（四层解析）

插件**不读配置文件里的值**——它按下面顺序解析引用名：

```
进程环境变量  →  DSH 托管凭据文档  →  <cwd>/.env  →  <DSH_HOME>/.env
```

- `<DSH_HOME>` 默认 `~/.dsh`（Windows：`C:\Users\<你>\.dsh`）
- `.env` 一行一个 `名字=值`；**不加引号、不加 `export`、不留行尾空格**
- **每次请求都重新解析、不缓存**，所以改值后下一个请求即生效

示例（`<DSH_HOME>/.env`）：

```text
A2A_TOKEN_PEER_B=<把 32 字节随机值粘在这里>
```

> 优先用 DSH 的凭据界面写入，让值留在托管层；直接编辑 `.env` 也可以，
> 但要确认该文件权限只对当前用户可读。

### 2.4 加载期校验做了什么、没做什么

**做**：引用名格式、令牌**值**是否被误写进配置、对端标识字符集、
`trustedPeers` 是否引用未声明的对端、监听地址是否通配、`basePath` 是否以 `/` 开头。

**不做**：不校验 token 强度（32 字节是你的责任）、不校验对端是否可信、不加密你的配置文件。

---

## 3. 轮换 token

### 3.1 机制

凭据是**每请求解析**的，所以改值的生效时间是**下一个请求**——不需要重启 DSH，也不需要改配置。

### 3.2 标准轮换步骤

1. 生成新 token
2. 写入凭据层（覆盖同一个引用名）
3. 立刻用新 token 发一次请求验证

### 3.3 已知限制：轮换存在短暂的 401 窗口

当前实现里，一个对端只解析出**一个** secret。在对端也切到新值之前，
它会用旧值请求并被 401 拒绝。

**处置**：把轮换当成一次协同操作——先换本机、立即换对端，或在维护窗口内完成。
若要"新旧 token 并存、窗口内都接受"，需要把 `inbound.peers[*].tokenEnv`
扩展成引用名列表；这是本插件**尚未实现**的能力。

### 3.4 轮换周期

| 场景 | 建议 |
|---|---|
| 局域网、设备都在你控制下 | 90 天，或人员/设备变动时立即换 |
| 有他人可接入的网络 | 30 天 |
| 怀疑泄露 | 立刻换，并按"已泄露"处置（见第 8 节） |

---

## 4. 三档升级路径

### 4.0 对照

| 档 | 传输 | 防护 | 成本 | 适用 |
|---|---|---|---|---|
| ① | 明文 HTTP + Bearer | token 能防未授权调用，**防不了嗅探** | 无 | 完全受控的局域网、MVP |
| ② | TLS（自签或私有 CA） | 链路加密 + 服务端身份 | 低 | 局域网内有他人设备 |
| ③ | 加密覆盖网络（Tailscale / WireGuard 等） | 链路加密 + 设备身份 + 网络隔离 | 中 | 跨网段、远程接入 |

### 4.1 档①：明文 HTTP

真实风险只有一条，但很关键：**Bearer token 在明文链路上可被嗅探**。
一旦被嗅探，攻击者获得的是**完全等价的身份**，直到你轮换。

以下措施**不能替代加密**，只能降低概率：

- 32 字节强随机 token（不可猜）
- 常时比较（不泄露比较进度）
- 每对端限流（降低暴力枚举可行性）
- 只对具体地址监听 + 防火墙只放行对端地址

> **实现事实**：本插件的入站监听器是插件自己创建的 `node:http` 服务器
> （不挂在 DSH 的 web 服务上），**目前没有内置 TLS 开关**。
> 因此档②需要在外层加 TLS（反向代理，或等待监听器的 TLS 支持）。
> 详见 `threat-model.md` 的对应条目。

### 4.2 档②：TLS

生成一张自签证书（或由你的私有 CA 签发），由 TLS 终结层承担加密，
A2A 客户端把该证书加入信任链。

```bash
# 生成自签证书（OpenSSL 1.1.1+；Git for Windows 自带的版本满足）
openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
  -keyout a2a.key -out a2a.crt \
  -subj "/CN=<本机IP或主机名>" \
  -addext "subjectAltName=IP:<本机IP>"
```

客户端侧让 Node 信任它（二选一）：

```bash
# 临时（当前进程）
NODE_EXTRA_CA_CERTS=/path/to/a2a.crt dsh --profile <profile>

# 持久（Windows）
setx NODE_EXTRA_CA_CERTS "C:\path\to\a2a.crt"
```

> 825 天是公有信任链的惯例上限；自签不受强制，但也没有签更长的理由。
> 用了 TLS 之后，`outbound.contacts[].url` 要改成 `https://`。

### 4.3 档③：加密覆盖网络（推荐的中期目标）

把两台机器加入同一个加密覆盖网络，A2A 只在覆盖网络地址上监听与访问：

- 得到：链路加密、设备身份、NAT 穿透
- 失去：几乎没有（延迟略增）
- **重要**：把 `inbound.listen.host` 改成**覆盖网络接口的地址**，
  而不是物理网卡地址，否则物理网段上仍然暴露明文端口

---

## 5. 防火墙

### 5.1 目标

只让**对端**访问 A2A 端口，其余一律拒绝。默认拒绝、按需放行。

### 5.2 检查与新增（Windows 管理员 PowerShell）

```powershell
# 1) 确认网络配置文件类型：Private 下放行才符合"内网"预期
Get-NetConnectionProfile | Select-Object Name, NetworkCategory

# 2) 确认端口当前状态
Get-NetTCPConnection -LocalPort 3081 -State Listen -ErrorAction SilentlyContinue

# 3) 新增：只允许对端地址，且只在 Private 配置文件
New-NetFirewallRule -DisplayName 'DSH A2A 3081' -Direction Inbound -Protocol TCP `
  -LocalPort 3081 -RemoteAddress 192.168.1.10 -Action Allow -Profile Private

# 4) 复核规则确实带地址限定
Get-NetFirewallRule -DisplayName 'DSH A2A 3081' |
  Get-NetFirewallAddressFilter | Select-Object RemoteAddress
```

Linux（ufw）：

```bash
sudo ufw allow from 192.168.1.10 to any port 3081 proto tcp
```

### 5.3 硬性纪律

- **不要**用 `-RemoteAddress Any` 图省事
- **不要**在 Public 网络配置文件下放行
- 端口一旦改动，防火墙与 `outbound.contacts[].url` 必须**同时**改
- 不需要入站的对端，把 `inbound.enabled` 设为 `false`，端口根本不监听

---

## 6. 地址写法：优先用 IP，不要用域名

### 6.1 为什么

先说清楚**实际实现**：本插件的出站客户端**目前不做 DNS 复查、也没有地址策略**
（`docs/threat-model.md` §4.2 把"出站地址策略"列为**未实现项 #2**）。

这不等于存在一条由对方驱动的 SSRF 通路：出站 URL 只来自运维在 `outbound.contacts`
里配置的地址，**peer 与模型都无法指定 URL**。但如果将来允许模型或对端给出 URL，
必须先补上地址策略再开放。

即便如此仍建议一律写 IP，原因有两个实测过的现实问题：

1. **fake-IP 类代理**会把域名解析成一个保留地址（如 `198.18.x.x`），请求打到了不存在的主机上；
2. 本插件的监听器按**具体地址**绑定、拒绝通配，而域名在**对端**解析出的地址未必就是你绑定的那个。

### 6.2 规范

- `outbound.contacts[].url` 与 `inbound.publicUrl` 一律写 **IP**
- `inbound.listen.host` 必须是**本机具体地址**：不是通配、不是域名
- 监听地址与对外宣告地址可以不同（NAT / 代理场景下必须不同）

### 6.3 确实必须用域名时

确认该域名在本机的解析**不经过**会把结果替换成保留地址的代理；
否则临时开启跳过开关做排障，**但不要留在生产配置里**。

---

## 7. 验证清单

配完逐条过，任一条不符合就说明配置有问题。

### 7.1 无凭据必须 401

```bash
curl -i -X POST http://<本机IP>:3081/a2a \
  -H 'content-type: application/json' -H 'a2a-version: 1.0' \
  -d '{"jsonrpc":"2.0","id":1,"method":"SendMessage","params":{}}'
```

期望：`401` 且带 `www-authenticate`；**body 仍是合法的 JSON-RPC 错误信封**。

### 7.2 卡片可匿名读

```bash
curl -s http://<本机IP>:3081/.well-known/agent-card.json
```

期望：`200` + Agent Card JSON。不需要匿名发现时把 `card.public` 设为 `false`。

### 7.3 带正确 token 必须通

```bash
curl -s -X POST http://<本机IP>:3081/a2a \
  -H 'content-type: application/json' -H 'a2a-version: 1.0' \
  -H "authorization: Bearer $A2A_TOKEN_PEER_B" \
  -d '{"jsonrpc":"2.0","id":1,"method":"SendMessage","params":{"message":{"messageId":"probe-1","role":"ROLE_USER","parts":[{"text":"ping"}]}}}'
```

期望：`200` + JSON-RPC `result`。若返回 `-32603` 且消息含「尚未选择模型」，
说明模型没配——去插件页选（见 README「模型选择」）。

### 7.4 轮换验证

换 token → 旧 token 应 401、新 token 应 200，**全程不用重启**。

### 7.5 其余检查

- [ ] 错误码只用 `-32001..-32009`（协议语义）与 `-32700..-32600`（JSON-RPC 保留段）
- [ ] 鉴权/限流/信任失败走 HTTP 状态码（401/403/429/413），body 仍是 JSON-RPC 信封
- [ ] `trustedPeers` 只包含你确实要放行的对端
- [ ] `isolation.workspaceMode: per-peer`（除非刻意共享工作目录）
- [ ] 防火墙规则带 `-RemoteAddress`，且 `-Profile Private`

---

## 8. token 卫生（六条，违反任一条等同泄露）

1. **不写进配置文件**——配置里只出现引用名
2. **不进 git**——`.env` 已被 `.gitignore` 忽略，不要 `git add -f`
3. **不进日志**——插件对出站内容做脱敏，但你自己贴日志时要注意
4. **不进聊天工具 / 工单**——贴出去就等于公开
5. **一个对端一枚**——不要复用，不要"临时共用一下"
6. **怀疑泄露就立即轮换**，并把该 token 视为已被使用过

---

## 9. 与威胁模型的对应关系

本文每条措施在 [`threat-model.md`](threat-model.md) 里都有对应的风险条目与残余风险。
配置层面无法消除的残余风险（明文嗅探、跨对端工具调用未被策略约束等）在那里逐条列出——
**部署前请至少读一遍"残余风险"小节**。
