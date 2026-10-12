# Cloudflare Worker / D1 / R2 接口

默认前端完全本地。这里提供**可部署的单所有者 API 骨架与快照同步实现**，没有替你创建 Cloudflare 资源或部署。真实环境需要验证。

## 架构与契约

- 账本：`schema: 1`；所有金额都是原币种的整数分。
- `LocalAdapter`：`load()`、`save(data)`，同步浏览器存储。
- `WorkerAdapter`：`pull()`、`push(data, expectedVersion)`、`uploadAttachment(blob)`、`getAttachment(key)`、`deleteAttachment(key)`。
- D1：一行 `ledger` 保存当前版本、R2 对象键和更新时间。
- R2：保存完整账本快照；成功替换时旧快照保留，用于人工恢复。未附自动保留期限 / 清理任务。
- R2 附件端点可供后续接入；当前 UI 不主动上传独立附件，快照包含本地附件 data URL。
- 新快照先写 R2，再通过 D1 条件 UPDATE / INSERT 提交版本指针。竞争失败返回 409，并删除该次新上传对象。
- 若 Worker 在 R2 写入后异常中止，可能留下未引用对象；以后可增加后台回收任务。
- 单个快照请求上限 8 MiB，独立附件 2 MiB。D1 只保存小型元数据，避免将整份快照塞进单行文本。
- 快照下载 / 上传是手动整体替换；不是增量同步，也不是字段级冲突合并。

## 部署步骤（以后需要时再做）

在 `worker/` 目录执行。需要自己的 Cloudflare 账号、Wrangler 与相应服务权限。

```bash
npx wrangler login
npx wrangler d1 create cashew
npx wrangler r2 bucket create cashew-private
```

将创建 D1 返回的 UUID 写入 `wrangler.toml` 的 `database_id`。桶名与配置一致。

```bash
npx wrangler d1 migrations apply cashew --remote
npx wrangler secret put API_TOKEN
```

令牌使用至少 32 个字符的随机值，建议用密码管理器生成。不要硬编码到前端或提交至仓库。

在 `ALLOWED_ORIGINS` 中设置你的精确来源，例如：

```toml
ALLOWED_ORIGINS = "https://YOUR_NAME.github.io,http://localhost:8000"
```

Origin 不包含仓库路径、不带尾部斜线。不使用 `*`，不接受 `null` 的 file:// 来源。需要云同步时请通过 localhost 或 HTTPS 打开应用。

```bash
npx wrangler deploy
```

然后在前端 **设置 → 云端连接** 输入 Worker URL 和令牌，点击“连接并检查”。先通过连接检查，再上传或下载。

本地开发可使用 `npx wrangler dev`；将令牌写到被 `.gitignore` 排除的 `worker/.dev.vars`。本地 D1 使用：

```bash
npx wrangler d1 migrations apply cashew --local
```

## HTTP API

所有真实操作均要求 `Authorization: Bearer <API_TOKEN>`。OPTIONS 只处理受允许来源的预检。API_TOKEN 未配置或不足 32 字符时返回 503，拒绝读写。

| 方法 | 路径 | 输入 | 成功响应 |
|---|---|---|---|
| GET | `/v1/health` | 无 | `{ok:true,schema:1,mode:"single-owner"}` |
| GET | `/v1/snapshot` | 无 | `{version:0,data:null}` 或 `{version:N,data:Ledger}` |
| PUT | `/v1/snapshot` | `{expectedVersion:N,data:Ledger}` | `{version:N+1,updatedAt:ISODate}` |
| POST | `/v1/attachments` | 图片二进制，正确的 Content-Type | 201 `{key,size,type}` |
| GET | `/v1/attachments/:key` | UUID | 图片二进制 |
| DELETE | `/v1/attachments/:key` | UUID | 204 |

常见状态：400 数据无效；401 令牌不正确；403 来源不允许；409 云端版本冲突；413 超出大小；415 图片格式不支持；503 绑定 / 配置缺失。

发生 409 后，先导出本地 JSON，重新连接读取云端版本，再下载检查。不要无条件覆盖别人的更改。当前只有一个所有者空间，不支持多人共享同一令牌并发协作。

## 后续扩展位置

1. **身份与多用户**：用 JWT / Cloudflare Access 验证替换 `authorized()`，通过已验证的用户标识分区 D1 主键和 R2 前缀；绝不相信请求体里的 owner ID。
2. **增量同步**：在模型中增加每条记录的版本与删除标记，新增 `/v1/changes` 和冲突处理 UI。
3. **附件外置**：先上传 R2，再在本地模型保存附件 key；扩展验证器和 UI 图片加载。现有 `attachments[].data` 保持本地兼容。
4. **持久化升级**：改用 IndexedDB 时将启动与提交改为异步，保留 JSON 导入导出。
5. **汇率服务**：以后增加 `/v1/rates`，记录来源 / 时间戳，再替换手动汇率表；当前没有实时汇率抓取。
6. **共享预算 / 邀请**：需独立权限模型、服务端范围检查与审计，当前没有启用相关功能。

官方参考：

- <https://developers.cloudflare.com/d1/worker-api/d1-database/>
- <https://developers.cloudflare.com/d1/worker-api/prepared-statements/>
- <https://developers.cloudflare.com/d1/wrangler-commands/>
- <https://developers.cloudflare.com/r2/api/workers/workers-api-reference/>
- <https://developers.cloudflare.com/workers/wrangler/configuration/>
