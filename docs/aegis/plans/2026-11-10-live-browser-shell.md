# 实现计划：直播浏览器壳（live browser shell）

## 目标（一句话）
给 browserless v2.59.0 定制版加一个免鉴权的"浏览器壳"页面（标签页栏 + 网址栏 + 加号 + 实时画面），内网设备直接打开即监督智能体干活并亲手操作。

## 七问

1. **改什么、不改什么**：新增 3 个文件（壳页面路由、CDP 多路复用转发路由、云构建 workflow）+ 检查路由挂载是否需要 1 处标记补丁。不改上游任何已有路由、浏览器生命周期、限流、Dockerfile。
2. **为什么必须改代码**：免鉴权要求令牌只存服务端（前端不能持有），且白名单过滤（禁 Runtime.evaluate 等）必须在服务端执行——纯前端旁路方案无法同时满足"免鉴权 + 白名单"，故落在本 fork 内。
3. **归属方与文件**：仓库 Observe-Life/browserless 分支 v2.59.0-customize。
   - `src/routes/management/http/nav.get.ts`：免鉴权，返回内嵌 HTML/CSS/JS 的壳页面
   - `src/routes/management/ws/live.ts`（目录/文件名以 T1 路由发现机制结论为准）：免鉴权 WS 转发层
   - `.github/workflows/docker-image.yml`：云构建推 ghcr
   - `src/browserless.ts`：若需显式注册则加 `[LIVE-NAV PATCH]` 标记块（目标 ≤5 行）
4. **什么必须保持兼容**：上游全部现有路由（/chromium、/debugger、/session、/pressure、/devtools/*）行为不变；CONCURRENT/HEALTH/TOKEN 等环境变量语义不变；docker/chromium/Dockerfile 不改。
5. **证明改对**：① GitHub Actions 构建绿且 ghcr 镜像可拉；② 容器起来后 `curl :3000/nav` 返回壳页面；③ WS 转发连通脚本实测（targets 列表、createTarget、navigate、screencast 帧）；④ 回归：原 /debugger 页面与 /chromium 正常。
6. **风险**：路由自动发现机制不识别新文件（T1 消除）；活动实例 → browser WS endpoint 的取值路径未验证（T2 消除）；免鉴权路由在框架内的鉴权中间件行为（T1 消除）。
7. **退役线**：无旧路径退役。"纯前端旁路"方案有意不采用（理由见第 2 问），退役条件：上游未来提供官方免鉴权调试台则整体移除本增量。

## 测试路线

- **模式**：关闭严格 TDD
- **决策**：轻量
- **依据**：按风险自判（计划写明）
- **理由**：CDP 转发链路无法用单测覆盖，验证主战场是真实容器行为（构建 → 部署 → 实测）
- **怎么验证**：见第 5 问四条

## 任务拆分

| # | 任务 | 文件 | 最小改动 | 验证 |
| --- | --- | --- | --- | --- |
| T1 | 路由发现与免鉴权机制研究 | src/router.ts、src/http.ts（只读） | 无改动 | 能明确：新路由文件命名/目录、auth=false 生效路径 |
| T2 | 实例发现 API 验证 | src/browser-manager.ts（只读） | 无改动 | 明确"活动会话 → browser WS endpoint"取值路径与 ID 对应 |
| T3 | 转发层实现 | 新增 1 个 WS 路由文件 | 白名单过滤 + 多路复用 + 生命周期（旁观不拥有） | 构建期编译通过 + T6 实测 |
| T4 | 壳页面实现 | nav.get.ts（内嵌前端） | 标签栏/加号/网址栏/画面/只读接管开关 | T6 手机人工验收 |
| T5 | 云构建 workflow | .github/workflows/docker-image.yml | push customize 分支触发构建推 ghcr | Actions 绿、ghcr 可拉 |
| T6 | 部署与验收 | 宿主机 compose | 换镜像部署 backend 网桥 | 14 文档收尾清单 |

## 界面验收判据（04，可观察）

1. 打开 http://192.168.31.115:3001/nav：显示标签页栏 + 网址栏 + 内容区；无标签页时内容区为空白页样式。
2. 智能体在任一会话开新页：壳的标签栏在数秒内长出新标签（标题/网址可见）。
3. 点"+"：出现新空白标签并自动选中；网址栏输入网址回车：该标签页导航并在画面上看到结果。
4. 默认只读：鼠标事件不上传；切"接管"后画面内点击/输入生效；切回只读立即停止上传。
5. 关闭壳页面：智能体的浏览器与标签页继续存在、工作不中断。

## 出口
T6 通过 → 14-验证与收尾；决策沉淀 → 17-决策沉淀。
