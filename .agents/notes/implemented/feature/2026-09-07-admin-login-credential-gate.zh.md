# Agent Note: 管理员邮箱+密码登录是 `dsh web` 唯一的登录方式

Status: implemented

[English](2026-09-07-admin-login-credential-gate.md) | 中文

## 问题

`dsh web` 此前的访问控制是启动令牌流程：每个进程随机生成一个令牌并打印在启动 URL 中，凭它一次性换取签名的浏览器会话 cookie（参见[浏览器启动令牌认证](../architecture/2026-08-24-browser-token-authentication.zh.md)）。这个模型假定只有一名能读取该进程 stdout 的操作者。它没有可以交给他人的具名凭据，也没有为想用邮箱+密码登录、而不是从终端里复制 URL 的操作者提供登录入口——而且由于签名密钥与会话获取方式无关，之后想把某次部署锁定起来时，也没有办法在不连带轮换掉所有现有会话所依赖的那个密钥的情况下做到。

## 决策

`dsh-client-connection` 现在要求用管理员邮箱+密码登录才能进入 `dsh web`；没有其他入口。`requireAdminCredentials`（`src/admin-login.ts`）在插件启动时从进程环境中读取一次 `ADMIN_EMAIL` 与 `ADMIN_PASSWORD`，只要缺一个就抛出异常——使插件 fiber 失败，进程也就永远不会开始监听。原始密码会被立即哈希一次（`scrypt`，配新生成的随机盐）后即被丢弃；只有派生出的盐/哈希，以及邮箱的 SHA-256 摘要，会保留在内存中，且仅限进程生命周期内。任何内容都不会写入 `.credentials.yaml` 或其他任何地方，原始密码也绝不会出现在任何日志行中。

`BrowserAuth.authorizeIndex`（`src/browser-auth.ts`）会为未认证的 `GET /` 提供一个自包含、无脚本的 HTML `<form method="POST">`（`src/login-form.ts`）；其他任何未认证请求都会得到既有的纯文本 401。该表单提交到一个 exact 路由 `POST /login`（`packages/client/connection/src/index.ts`、`src/login-route.ts`），其注册位置排在 SPA 回退席位之前。`verifyAdminLogin`（`src/admin-login.ts`）会无条件地同时计算邮箱摘要和密码哈希，分别用 `timingSafeEqual` 比较后再做逻辑与运算，因此邮箱错误与密码错误消耗的 CPU 时间完全相同——既不会暴露账号是否存在，也不存在计时侧信道。提交正确时会签发与已移除的令牌交换曾经签发的完全相同的、绑定 authority 的签名会话 cookie（`BrowserAuth.mintCookie`）；提交错误时会重新展示表单，并附带一句通用的"Invalid email or password."提示。`src/login-throttle.ts` 会在运行任何 `scrypt` 比较之前，先对失败尝试按来源 IP 施加固定的指数退避（500ms 起倍增，上限 30 秒，且跟踪的 key 数量有上限）——该曲线是安全不变量，而不是 `Config` 字段，操作者无法削弱它。此时 `authenticatedUrl` 打印的是纯净的根 URL，因为凭据就是操作者已经持有的邮箱和密码，不再需要靠链接携带任何东西。

持久会话 cookie 的机制——签名、绑定 authority 的 `HttpOnly`/`SameSite=Strict` cookie，通过 `@deepseek-ai/dsh-credentials` 持久化的 owner-scoped `client-connection/browser-session` HMAC 密钥，以及"删除记录并重启即可撤销所有会话"这一全局撤销机制——相对被取代的令牌流程都没有变化；变的只是用来签发 cookie 的那份凭据本身。

## 备选方案

**让管理员登录作为可选项与启动令牌流程并存（两条凭据路径都可用，由是否设置了 `ADMIN_EMAIL`/`ADMIN_PASSWORD` 决定选用哪一条）。** 最初就是这样实现的，后来又撤销了：两条路径共用同一个签名密钥，因此在其中一条路径下获得的浏览器会话，在进程切换到另一条路径后依然有效——想用登录锁定某次部署的操作者，会发现一个通过旧令牌获得的浏览器标签页仍然能用。要补上这个缺口，需要在 cookie 中打上模式标记并在不匹配时拒绝，这给一个系统本就不想保留的启动令牌路径增加了实实在在的复杂度。完全移除令牌流程则同时消除了这份复杂度和这个缺口：只剩一种凭据，也就不存在 cookie 的"模式"需要互相校验的问题。

**构建完整的多用户账户系统（注册、密码重置、角色）。** 没有任何需求要求支持一个以上的管理员身份；这个代码库中原本不存在任何用户数据库，为单一硬编码的操作者搭建一套从第一天起就用不上的体系没有意义。

**像今天持久化浏览器会话 HMAC 密钥那样，通过 `@deepseek-ai/dsh-credentials` 持久化（哈希后的）管理员密码。** 本次迭代未采用：该特性最初被提出的字面形式 `ADMIN_EMAIL=... ADMIN_PASSWORD=...` 就暗示着每次启动都重新提供凭据；不做持久化也就意味着磁盘上不存在任何"密码形状"的内容需要保护或轮换。若未来操作者希望凭据无需每次重新导出环境变量也能保留，持久化仍是一个自然、向后兼容的后续增强。

**用客户端 JavaScript（基于 fetch 的提交、内联校验）渲染登录页。** 一个纯 `<form method="POST">` 无需脚本、无需处理 CORS，也不存在客户端与服务端校验逻辑走样的风险；这也与"SPA/插件图必须在认证成功前绝不加载"这一约束一致——一个无脚本页面本身不可能成为该插件图提前落地的立足点。

**跳过登录尝试限流。** 一旦操作者之后用 `--host 0.0.0.0` 绑定，该网关就可能经由局域网被访问；若不限流，一个直接对着 `ADMIN_PASSWORD` 字符串做猜测的攻击会非常容易得手。固定、不可配置的指数退避能够限制猜测速率，且不引入额外的运维旋钮。

## 后果

`dsh web` 现在如果没有同时设置 `ADMIN_EMAIL` 与 `ADMIN_PASSWORD` 就不会启动——相对此前"总是匿名启动令牌"的行为，这是一次刻意的、对部署可见的破坏性变更；每一个启动脚本和 CI 环境在启动 `dsh web` 时都必须同时提供这两个变量。该凭据仅在进程生命周期内有效：如果重启时没有重新导出这两个变量，现在会直接启动失败（fail-closed），而不是回退到其他访问路径。服务器本身依旧不提供 TLS，因此凭据与会话 cookie 在 loopback 之外的网络上仍是明文传输；这一特性并未改变这个边界，README 也明确说明了这一点。内存中的 `LoginThrottle` 是单进程的，且仅按来源 IP 做区分，因此它能减缓单一来源的猜测速度，但无法防御分布式的洪泛攻击——这是为了保持单进程、无外部依赖的缓解方案而接受的权衡。

## 测试

单元测试（`tests/admin-login.host.spec.ts`、`tests/login-throttle.spec.ts`、`tests/login-route.host.spec.ts`、`tests/browser-auth.host.spec.ts`）覆盖：只要缺少任一变量（包括两者都未设置）`requireAdminCredentials` 就会抛出异常，且不再返回"已禁用"状态；每次读取都产生新的盐/哈希；邮箱与密码正确/错误情形下的恒定时间接受/拒绝；退避曲线及其上限；各 key 相互独立；超出跟踪上限时的淘汰行为；`/login` 的每一种 HTTP 结果（405、429、声明长度与实际长度两种超限情形下的 413、提交非法或错误时的 401、成功时携带 cookie 的 303）；`authorizeIndex` 对任何未认证的 `GET /` 始终返回登录页、对其余情况一律返回 401；以及 `authenticatedUrl` 不再携带任何凭据。`tests/node-half.host.spec.ts` 通过 `apply()` 的真实路由注册覆盖同样的行为，包括启动时的异常与一次完整的 `/login` 往返。`apps/cli/tests/web-auth.e2e.ts` 会启动真实的 `dsh web` CLI：一个用例证明不同时设置两个环境变量就会拒绝启动；另一个演练完整的 HTTP 流程（返回登录表单、拒绝错误密码、限流、登录成功、一次已认证的 `/api` 调用）；第三个证明伪造的 loopback `Host` 依旧会被拒绝，且通过 `/login` 获得的会话能在同一个 `$DSH_HOME` 上跨进程重启继续有效。
