# Cashew HTML 本地版

一个无需构建、无需登录的原生 HTML / CSS / JavaScript 记账应用。

**这是非官方重实现，不是原版 Flutter 的逐文件移植，也不是已验证的 100% 像素 / 功能等价版本。** 原项目本身已有 Flutter Web 版；原生平台能力及原云服务没有被嵌入本项目。已实现与未实现项目见 [FEATURES.md](FEATURES.md)。

## 立即运行

### 单文件

打开交付包里的 `Cashew.html`，所有样式、脚本、字体与图标均已内嵌。无需联网、无需 npm。

浏览器若限制 `file://` 本地存储，使用下面的本地服务器方式。不同 URL / 端口 / 浏览器的本地数据不共享；更换打开方式前先导出 JSON。

### 推荐：本地服务器

在解压后的 `cashew-web` 文件夹中运行：

```bash
python3 -m http.server 8000 --bind 127.0.0.1
```

Windows 可使用：

```powershell
py -m http.server 8000 --bind 127.0.0.1
```

打开 **http://localhost:8000**。首次进入可选择空白账本或示例账本。示例账本会明确显示“示例数据”。

本地 HTTP 服务器只是静态文件服务器，不是云端，不上传账本。请勿在共享电脑上把浏览器存储当作加密保险箱。

## 已接通的功能

- 首页：账户余额切换、预算卡片、月度概览、分类圆环、累计趋势、目标、即将到来、最近交易；支持模块开关和列内排序。
- 交易：收入 / 支出 / 转账、编辑、复制、删除、批量删除、搜索、日期 / 分类 / 账户 / 金额 / 状态筛选、标签、备注、收据图片、待支付状态。
- 账户与货币：多账户、期初余额、跨币种转账、自定义转入金额、手动汇率、显示货币切换。
- 预算：每日 / 每周 / 每月 / 每年 / 自定义周期；自动纳入或手动加入；账户 / 分类筛选、分类限额、近六期历史。
- 目标：储蓄与消费目标，初始进度与关联交易自动计算进度。
- 订阅 / 周期账单：日 / 周 / 月 / 年、暂停 / 恢复、手动支付本期并推进到下一期；月底日期保持原始日锚点。
- 借贷：借出 / 借入、本金交易、部分还款、剩余本金。
- 分类：图标、颜色、默认收支方向；交易名称关键词自动分类。
- 账单分摊：平均分摊到分，余数按名单顺序分配；仅计算，不自动记账。
- 数据：完整 JSON 备份 / 恢复、交易 CSV 导入 / 导出、CSV 模板。
- 外观：浅色 / 深色 / 跟随系统、自定义强调色、中英文 UI、手机与桌面适配。
- PWA：使用 `index.html` 在 localhost / HTTPS 下运行，首次缓存后支持离线打开。
- Cloudflare：可选单所有者 Worker API、D1 版本指针、R2 快照 / 附件接口。默认未启用。

快捷键：`N` 新增交易；`/` 搜索；`Esc` 关闭弹窗。

## GitHub Pages 部署

当前交付**没有创建或修改任何 GitHub 仓库，也没有部署线上站点**。

1. 在自己的 GitHub 账号下新建仓库，将本文件所在目录的内容放在仓库根目录，包括 `.github/workflows/pages.yml`。
2. 将默认分支设为 `main`，进入 **Settings → Pages → Build and deployment → Source → GitHub Actions**。
3. 推送到 `main`，或手动运行 `Deploy static Cashew to GitHub Pages`。
4. 工作流会检查语法、运行测试、生成 `dist/`，再部署静态前端。
5. 所有资源使用相对路径，支持 `https://用户名.github.io/仓库名/`。

也可以直接使用 GitHub Pages 的 **Deploy from a branch / main / root** 发布仓库根目录，无需构建。建议使用 Actions，只发布 `dist/`。

GitHub Pages 只能托管静态前端，不会执行 `worker/`。Cloudflare API 需另外部署，详见 [API.md](API.md)。

官方文档：<https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages>

## Cloudflare 预留接口

前端通过 `src/core.js` 的 `LocalAdapter` 和 `WorkerAdapter` 隔离数据访问。

默认用浏览器 `localStorage` 保存一个经过验证的完整账本快照；写入失败（例如额度用尽）时保留原账本，并提示错误。附件以 data URL 存在本地快照中。浏览器额度因环境而异，建议压缩收据并定期备份。

- `config.js` 的 `apiBaseUrl` 可设置默认 Worker URL，也可在设置页填写。
- 令牌仅存于当前页面内存，**不要写入 HTML、config.js、GitHub 或仓库文件**。
- 设置页提供连接检查、手动上传与下载；上传使用 `expectedVersion` 防止旧版本静默覆盖。
- R2 附件 CRUD 已留接口；当前前端仍使用内联本地附件，**没有自动把附件迁移到 R2**。
- `storageAdapter` 可替换为具有同步 `load()` / `save(data)` 的适配器。若改用异步 IndexedDB，应同时把应用初始化 / 提交流程改成异步，不可直接替换同步 API。

## 开发与验证

前端运行零依赖。测试 / 打包需要 Node.js 24（Worker 测试使用 `node:sqlite`）。

```bash
npm run check
npm test
npm run build
```

`npm run build` 生成：

- `Cashew.html`：可单独打开的完整 HTML。
- `dist/`：GitHub Pages 静态部署目录。

`npm test`：19 项核心账务与 Worker 接口测试；Worker 使用真实本地 SQLite 模拟 D1 绑定及内存 R2，**未在 Cloudflare 真实环境部署验证**。

另已通过 DOM 模拟检查 11 个页面和主要表单流程。测试脚本 `tests/ui-smoke.cjs` 可选运行：

```bash
npm install --no-save linkedom@0.18.13
npm run test:ui
```

**当前交付未执行真实浏览器、视觉截图、PWA 安装和线上部署验证。** 请在目标浏览器复核后再保存真实账务。

更新静态资源后，递增 `sw.js` 的缓存版本，再部署；旧页面全部关闭后新缓存生效。

## 文件结构

```text
index.html                 普通静态网页入口
Cashew.html                已打包的单文件入口
styles.css                 响应式主题与组件样式
config.js                  可选 API / 存储配置
src/core.js                数据模型、计算、验证、CSV、适配器
src/app.js                 UI 与事件处理
assets/                    原项目图标、DM Sans 字体与字体许可
worker/                    可选 Cloudflare Worker + D1 迁移 + 配置模板
scripts/build.mjs          单文件与 dist 打包
.github/workflows/pages.yml GitHub Pages 工作流
tests/                     核心、Worker 与可选 DOM 测试
FEATURES.md                功能对照与边界
API.md                     Cloudflare 接入说明
THIRD_PARTY_NOTICES.md      原项目引用与许可证说明
LICENSE                    GPL-3.0 许可全文
```

## 来源

原项目：<https://github.com/jameskokoska/Cashew>

参考提交：`9cfbe50c16d95429891d44faf5f2c77a3abdb93b`。

保留原项目 GPL 许可及素材署名。原版品牌、设计与图标归原作者；本包是独立的非官方 HTML 重实现。见 `THIRD_PARTY_NOTICES.md`。
