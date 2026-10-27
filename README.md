# Gravatar API

一个运行在 Cloudflare Workers 上的 Gravatar 头像代理：第一次请求回源
`gravatar.com`，把图片字节存进 Workers KV，之后直接从 KV / 边缘缓存返回。

```http
GET https://api.careful.fyi/avatar/e3f8b5dfe92c59253bda03568ec664d5?s=80&r=G&d=identicon
```

可以直接放进 `<img>`：

```html
<img
  src="https://api.careful.fyi/avatar/e3f8b5dfe92c59253bda03568ec664d5?s=80&r=G&d=identicon"
  alt="avatar"
/>
```

## 哈希怎么来

Gravatar 用邮箱的哈希作为身份标识。规则是：

1. 去掉邮箱首尾空白
2. 全部转成小写
3. 计算 SHA-256（当前推荐）或 MD5（旧客户端仍在使用）

项目自带一个脚本：

```bash
npm run hash -- MyEmailAddress@example.com
```

输出：

```text
email:   myemailaddress@example.com
sha256:  84059b07d4be67b806386c0aad8070a23f18836bbaae342275dc0a83414c32ee
md5:     0bc83cb571cd1c50ba6f3e8a78ef1346
```

接口同时接受 32 位 MD5 和 64 位 SHA-256。邮箱本身不会出现在 URL、访问日志
或 KV 里。

## 参数

| 参数 | 必填 | 说明 |
|:--|:--:|:--|
| `s` / `size` | 否 | 头像尺寸，1–2048，默认 80。超出范围会夹取，非数字回退 80 |
| `d` / `default` | 否 | 默认图。不传时用 Gravatar 自己的默认头像 |
| `r` / `rating` | 否 | 最高分级：`g`、`pg`、`r`、`x`，默认 `g`，大小写不敏感 |
| `f` / `force` | 否 | `y` / `1` / `true` 时强制使用默认图 |
| `refresh` | 否 | `1` / `true` 时跳过 KV 和边缘缓存，强制回源 |

`d` 支持的内置值：

```text
404  mp  identicon  monsterid  wavatar  retro  robohash  blank  initials  color
```

> `d` 只接受上面的内置值；自定义默认图 URL 暂不支持，避免 KV 键被超长 URL
> 撑大。需要这个能力时可以再加「URL 校验 + 短 token」的方案。

短参数优先于长参数：同时传 `s` 和 `size` 时以 `s` 为准，`d` / `default`、
`r` / `rating`、`f` / `force` 同理。

路径上可以带一个图片后缀，方便那些要求扩展名的客户端：

```http
/avatar/<hash>.jpg
/avatar/<hash>.png
```

后缀只影响 URL 外观，实际 `content-type` 始终来自图片字节的魔数嗅探。

## 响应头

| Header | 说明 |
|:--|:--|
| `content-type` | 嗅探出的真实类型：`image/png`、`image/jpeg`、`image/gif`、`image/webp`、`image/avif` |
| `cache-control` | 正常图片 `public, max-age=<600–3600 随机>, stale-if-error=86400`；`refresh` / 404 / 错误为 `no-store` |
| `etag` | Gravatar 返回的 ETag，透传给客户端 |
| `last-modified` | Gravatar 返回的 Last-Modified，透传给客户端 |
| `x-gravatar-cache` | 这次响应的来路，见下表 |
| `x-gravatar-final-url` | 图片实际是从哪个地址取到的 |
| `x-gravatar-reason` | 走旧图或失败时的原因 |
| `cache-tag` | `gravatar, gravatar:<hash>`，可按 hash 精确清边缘缓存 |
| `cf-cache-status` | Workers Cache 介入时由 Cloudflare 添加 |

`x-gravatar-cache` 的取值：

- `FRESH` —— 命中 `av:now`，直接返回，零上游请求
- `STALE` —— 命中 `av:last` 返回旧图，可能正在后台刷新
- `MISS` —— 实时回源成功
- `NEGATIVE` —— 命中 `fail:`，这个变体最近返回过 404

## 错误

错误统一返回 JSON：

```json
{ "error": { "code": "INVALID_HASH", "message": "..." } }
```

| 状态码 | code | 场景 |
|:--|:--|:--|
| 400 | `INVALID_HASH` | 路径不是 `/avatar/<32 或 64 位十六进制>` |
| 400 | `INVALID_DEFAULT` | `d` 不是支持的内置值 |
| 400 | `INVALID_RATING` | `r` 不是 g/pg/r/x |
| 403 | `REFERER_NOT_ALLOWED` | 调用方（Origin / Referer）不在白名单 |
| 404 | `NOT_FOUND` | `d=404` 且该 hash 没有头像 |
| 405 | `METHOD_NOT_ALLOWED` | 方法不是 GET / HEAD / OPTIONS |
| 502 | `UPSTREAM_ERROR` | Gravatar 5xx / 网络错误 |
| 502 | `UPSTREAM_NOT_IMAGE` | 上游返回的不是受支持的图片 |
| 502 | `UPSTREAM_TOO_LARGE` | 超过 `MAX_AVATAR_BYTES` |
| 503 | `UPSTREAM_RATE_LIMITED` | Gravatar 返回 429，响应带 `retry-after` |
| 504 | `UPSTREAM_TIMEOUT` | 回源超时 |

另外还有两个运维端点：

```http
GET /health   → { "ok": true, "service": "gravatar-api" }
GET /         → 服务信息和使用示例
```

## 缓存分层

一个请求要穿过三层：

```text
  GET /avatar/<hash>?s=80&r=G&d=identicon
        │
        ▼
  ┌─────────────────────────────────────┐
  │ default 入口（网关，不缓存）          │  方法 → HOSTS 白名单 → hash/参数校验
  └───────────────┬─────────────────────┘
                  │ ctx.exports.Gravatar.fetch(…, { cf: { cacheKey } })
                  ▼
  ┌─────────────────────────────────────┐
  │ Workers Cache（边缘）                │  命中时 Worker 完全不执行，连 KV 都不读
  └───────────────┬─────────────────────┘
                  │ 未命中
  ┌─────────────────────────────────────┐
  │ Gravatar 入口（缓存开启）             │  av:now → fail: → av:last → 回源
  └───────────────┬─────────────────────┘
                  ▼
  ┌─────────────────────────────────────┐
  │ Workers KV                          │  av:now / av:last / fail:
  └─────────────────────────────────────┘
```

**为什么拆成两个入口？** Workers Cache 的缓存键只由「入口 + 路径与查询串 +
Worker 版本」组成，**不含 Referer / Origin**。如果把白名单校验放进被缓存的
那一层：

- 未授权的调用方能直接拿到缓存图；
- 某次合法的 403 会被缓存下来，之后所有人都收到 403。

所以网关永远不缓存（每次请求都跑校验），只把校验过的请求转交给被缓存的
`Gravatar` 入口。

**缓存键是什么？** 网关把 hash、尺寸、默认图、分级、强制默认和 refresh 标记
编进内部 URL：

```text
https://gravatar.internal/v1/avatar?h=<hash>&s=<size>&d=<d>&r=<rating>&f=<0|1>&x=<0|1>
```

路径与查询串**就是**缓存键。参数在进入内部 URL 之前已经规范化，所以：

- `?s=80` 和 `?size=80` 命中同一条缓存；
- `?r=G` 和 `?r=g` 命中同一条缓存；
- `refresh=1` 单独成键，且响应带 `Cache-Control: no-store`，永远不入边缘缓存。

## 存储

头像存在 Workers KV 里，**一个变体三个键**：

| 键 | TTL | 什么时候写 |
|:--|:--:|:--|
| `av:now:<hash>:<size>:<d>:<r>:<f>` | 随机 3–7 天 | 每次成功回源 |
| `av:last:<hash>:<size>:<d>:<r>:<f>` | 永不过期 | 每次成功回源 |
| `fail:<hash>:<size>:<d>:<r>:<f>` | 30 分钟 | Gravatar 返回 404（通常是 `d=404`） |

`<d>` 不传时用 `-` 占位，`<f>` 是 `0` / `1`。例如：

```text
av:now:e3f8b5dfe92c59253bda03568ec664d5:80:identicon:g:0
```

`av:now` 的 TTL 每次写入重新随机，这样各变体的过期时刻天然错开，不会出现
一大批条目同时到期、同时回源的情况。

### 键里存的是什么

**Value 就是图片的原始字节**，没有任何包装。读取时必须用
`type: "arrayBuffer"` —— 用 `type: "text"` 读会把所有不是合法 UTF-8 的字节
替换成 `�`，图片直接损坏。

**Metadata** 放图片之外的信息：

```json
{
  "ct": "image/png",
  "url": "https://gravatar.com/avatar/e3f8b5dfe92c59253bda03568ec664d5?s=80&d=identicon&r=g",
  "at": 1761000000000,
  "etag": "\"abc\"",
  "lastModified": "Fri, 08 May 2026 14:58:31 GMT"
}
```

| 字段 | 含义 |
|:--|:--|
| `ct` | 魔数嗅探出的真实内容类型 |
| `url` | 图片字节实际从哪个绝对地址取到的 |
| `at` | 写入时间（毫秒时间戳）。`av:last` 永不过期，清理脚本靠它判断年龄 |
| `etag` | Gravatar 的 ETag，可为空 |
| `lastModified` | Gravatar 的 Last-Modified，可为空 |

`fail:` 存的是失败原因（一段文本），同样是 30 分钟 TTL。

### 读取流程

Workers Cache 命中时，下面的流程整个不会发生。边缘未命中，Worker 里的顺序是：

```text
av:now 命中 ─────────────────────────────→ 返回                    [FRESH]
      ↓ 未命中
fail: 命中 → 直接 404，不碰上游          ─→ 返回                    [NEGATIVE]
      ↓ 未命中
av:last 命中 → 立刻返回旧图 + 后台刷新   ─→ 返回                    [STALE]
      ↓ 未命中
同步回源
  成功 → 写 av:last（永久）+ av:now（3–7 天）→ 返回                 [MISS]
  404  → 写 fail:（30 分钟）→ 404                                   [MISS]
  其他失败 → 有旧图给旧图，否则 502 / 503 / 504
```

几个设计取舍：

- **只有成功的图片才入库。** 失败不会覆盖任何已经存着的真头像。
- **只有明确的 404 才负缓存。** Gravatar 的 5xx / 超时是临时故障，写 30 分钟
  负缓存会让服务恢复后还被锁住。这类错误不写 `fail:`，下一次请求会重试。
- **上游挂掉时先给旧图。** `av:now` 过期而 `av:last` 还在，客户端立刻拿到旧图，
  不用等超时。
- **`d=404` 的 404 结果负缓存 30 分钟。** 需要立即重新确认时加 `refresh=1`；
  已经成功缓存过的图片仍按 `av:now` 的 3–7 天 TTL 提供。

`av:last` 永不过期，所以命名空间会随着查询过的变体持续增长。免费额度 1GB
大约能装几万个头像（按均 20KB 算），超出后转付费版 $0.50/GB-月。清理脚本见
下面的「运维」。

## 安全

- Worker 只请求固定的 `https://gravatar.com/avatar/<hash>`，没有用户可控的
  出网目标，因此不存在 SSRF 面。
- 响应体有上限（默认 5 MiB），流式读取，超限立刻断开上游连接。
- 图片类型由魔数决定，HTML 错误页、JSON、SVG 等一律拒绝。
- 调用方白名单同时比对 `Origin` 和 `Referer`；`example.com` 匹配自身和所有
  子域，`*.example.com` 只匹配子域。
- 错误响应统一 `cache-control: no-store`，不会被 Workers Cache 的启发式
  新鲜度缓存。

## 部署

```bash
npm install
npx wrangler login
npm run deploy
```

本地开发：

```bash
npm run dev      # 默认 http://localhost:8787
```

KV 已经配置好，namespace id 是：

```text
0fc90dc67cab469fa4e1a60a3782086c
```

只有换命名空间时才需要重新创建：

```bash
npm run kv:create
```

自定义域名不在 `wrangler.jsonc` 里预设。部署后到 Cloudflare Dashboard →
Workers & Pages → `gravatar` → Settings → Domains & Routes 添加
`api.careful.fyi`（或你自己的域名）。

如果只想先用 `*.workers.dev` 验证，把 `wrangler.jsonc` 里的 `workers_dev`
改成 `true` 再 deploy；验证完可以改回 `false`。

### 部署后验证

```bash
curl -sD - -o avatar.png \
  "https://api.careful.fyi/avatar/e3f8b5dfe92c59253bda03568ec664d5?s=80&r=G&d=identicon"
```

| 看什么 | 期望 |
|:--|:--|
| `content-type` | 真实图片类型 |
| `x-gravatar-cache` | 第一次 `MISS`，紧接着再请求是 `FRESH` |
| `cf-cache-status` | 边缘层出现 `HIT`；边缘副本过期（10–60 分钟）后会先再现一次 `MISS` |

### 排查

- **`cf-cache-status` 一直是 `MISS`** —— Workers Cache 没有介入（个别账号/版本
  组合不生效）。把 `WORKERS_CACHE` 改成 `"0"` 再 deploy：Worker 行为完全不变，
  只是没了边缘那一层。
- **403 `REFERER_NOT_ALLOWED`** —— 检查 `HOSTS`；服务端脚本或邮件客户端不带
  Referer，需要 `ALLOW_EMPTY_REFERER=1`。
- **KV 一直空** —— 用 `wrangler tail` 看实时日志，`x-gravatar-reason` 里会写明
  回源失败原因。
- **刚换了 Gravatar 头像但接口还是旧的** —— `av:now` 默认缓存 3–7 天，加
  `refresh=1` 强制刷新；或者把 `KV_EDGE_TTL_SECONDS` 调小，让新写入更快
  全球可见。

## 配置

所有配置都在 `wrangler.jsonc` 的 `vars` 里，改配置不用动代码。

| 变量 | 默认值 | 说明 |
|:--|:--|:--|
| `HOSTS` | `careful.fyi` | 允许调用接口的站点，逗号分隔，同时比对 Origin 和 Referer。留空表示不限制 |
| `ALLOW_EMPTY_REFERER` | `1` | 设为 `1` 允许既没有 Origin 也没有 Referer 的请求（邮件客户端、隐私模式、curl） |
| `WORKERS_CACHE` | `1` | 设为 `1` 走 `ctx.exports` loopback，让 Workers Cache 缓存出图层；边缘不生效时改 `0` 降级 |
| `KV_EDGE_TTL_SECONDS` | `3600` | KV 读请求的边缘缓存时长，也决定新头像最多多久全球可见 |
| `MAX_AVATAR_BYTES` | `5242880` | 头像体积上限（5 MiB） |
| `FETCH_TIMEOUT_MS` | `8000` | 单次回源的总预算 |

> **调用方白名单**。`HOSTS` 默认是 `careful.fyi`，也就是只允许你的站点。
> 浏览器嵌 `<img>` 会带页面域名当 Referer，页面里的 `fetch()` 跨域时带的是
> Origin —— 两个头都会比对。`example.com` 匹配自身和所有子域，
> `*.example.com` 只匹配子域。
>
> `ALLOW_EMPTY_REFERER=1` 是头像场景的实用默认值：邮件客户端和隐私模式通常
> 不带 Referer，严格设为 `0` 会让这些请求拿不到头像。如果要严格防盗链，把它
> 改成 `0`，并接受这类请求被 403 挡掉。

## 运维

`av:now` 靠 TTL 自己回收，`av:last` 需要手动清理。`wrangler kv key list` 能直接
看到每个条目的来源：

```bash
npx wrangler kv key list \
  --namespace-id 0fc90dc67cab469fa4e1a60a3782086c \
  --prefix av:last:
```

```json
{
  "name": "av:last:e3f8b5dfe92c59253bda03568ec664d5:80:identicon:g:0",
  "metadata": {
    "ct": "image/png",
    "url": "https://gravatar.com/avatar/e3f8b5dfe92c59253bda03568ec664d5?s=80&d=identicon&r=g",
    "at": 1761000000000
  }
}
```

清理脚本按 metadata 里的 `at` 判断年龄：

```bash
npm run kv:gc -- --prefix av:last: --older-than 30d          # 只报告
npm run kv:gc -- --prefix av:last: --older-than 30d --delete  # 真删
npm run kv:gc -- --local --older-than 30d                      # 本地开发数据
```

`wrangler kv key list` 每次最多返回 1000 个键；报告里恰好是 1000 个就再跑一次，
直到列出的数量变少为止。`wrangler kv key list` 和 `wrangler kv key delete` 都是
计费操作，所以脚本默认只报告，加了 `--delete` 才动手。

## 测试

```bash
npm test
```

测试跑在真实的 Workers 运行时里（[`@cloudflare/vitest-plugin`](https://github.com/cloudflare/workers-sdk)），
所以 KV 的行为跟线上完全一致。出网请求由
[`@msw/cloudflare`](https://github.com/mswjs/msw) 拦截，测试不会访问公网。

```bash
npm run typecheck   # TypeScript 类型检查
```

## License

MIT。
