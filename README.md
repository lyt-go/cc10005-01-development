# 多源异构数据接入引擎

面向多源异构数据接入、智能代理调度、动态限速、爬虫深度管理、数据去噪、格式转换与采集质量监控的数据接入工程管理平台。

这是一个前后端分离的管理平台：前端 React + Vite + TypeScript，后端 FastAPI（Python）。
两边各自独立启动，前端 dev server 已关掉自动打开页面，启动后按终端打印的地址手工打开。

## 目录结构

```text
.
├── frontend/                 React + Vite + TypeScript 前端
│   ├── src/views/            每个业务模块一个页面
│   ├── src/api/              统一请求封装
│   ├── src/stores/           会话与筛选状态
│   └── vite.config.ts        dev server 配置（open: false）
├── backend/                  FastAPI（Python） 后端
│   ├── app/routers/          每个业务模块一组接口
│   ├── app/services/         业务规则与状态流转
│   └── app/store.py          内存数据仓库与示例数据
├── .gitignore
└── docker-compose.yml
```

## 启动

### 后端

```bash
cd backend
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
./run.sh
```

健康检查：`curl http://127.0.0.1:8000/api/health`

### 前端

```bash
cd frontend
npm install
npm run dev
```

前端默认监听 `http://127.0.0.1:5173/`，dev server 不会自动打开浏览器，
需要自己访问。`/api` 由 vite 代理到后端 `http://127.0.0.1:8000`。

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 连接器管理 | `connector` | 数据连接器 | 连接器编号、协议类型、目标端点、目标域 |
| 代理池管理 | `proxypool` | 代理实例 | 实例编号、代理地址、代理端口、允许目标域、当前连接数、容量上限 |
| 代理准入预检 | `admission` | 接入准入记录 | 准入编号、连接器编号、实例编号、代理地址、接入准入结论、采样时刻、负载采样时刻、权重来源 |
| 深度爬取 | `deepcrawl` | 爬虫配置 | 配置编号、种子URL、最大深度 |
| JS渲染采集 | `jsrender` | 渲染配置 | 配置编号、目标URL、浏览器类型 |
| 字段解析器 | `parser` | 解析模板 | 模板编号、目标字段数、XPath表达式 |
| 数据去噪 | `dataclean` | 去噪规则 | 规则编号、目标字段、HTML标签清理 |
| 格式转换 | `formatter` | 转换器 | 转换器编号、输入格式、输出格式 |
| 采集去重 | `dedupengine` | 去重引擎 | 引擎编号、去重字段组、哈希算法 |
| 动态限速 | `throttle` | 限速规则 | 规则编号、目标域组、初始速率 |
| 验证码处理 | `captcha` | 验证码策略 | 策略编号、验证码类型、识别服务商 |
| 采集监控 | `monitor` | 监控面板 | 面板编号、监控指标集、采样间隔秒 |
| 数据分发 | `exporttask` | 分发任务 | 任务编号、数据源标识、目标系统 |
| 种子管理 | `seedmgr` | URL种子 | 种子编号、种子URL、发现来源 |
| 站点地图 | `sitemap` | 站点描述 | 站点编号、站点域名、robots规则 |
| Cookie管理 | `cookiejar` | 会话凭证 | 凭证编号、所属站点、登录方式 |
| 采集器健康 | `healthcheck` | 健康报告 | 报告编号、采集器名称、CPU占用率 |
| 采集快照 | `snapshot` | 数据快照 | 快照编号、关联任务、快照时间 |
| 操作审计 | `audittrail` | 审计记录 | 记录编号、操作类型、操作对象 |

## 约定

- 每个模块的前端页面在 `frontend/src/views/<模块>/index.vue`，后端接口在
  `backend/app/routers/<模块>.py`，业务规则在 `backend/app/services/<模块>.py`。
- 列表接口统一返回 `{ items, total, page, size }`，动作接口统一返回 `{ ok, message }`。
- 状态流转只允许在 `app/services` 里改，路由层不做业务判断。

### 代理可用性预检与接入准入

- 预检入口：`POST /api/admission/precheck`，传 `connector_id`（必选）与 `proxy_id`（留空时按
  分配权重高、负载低自动选优）。评估维度：目标域允许的代理地址（支持 `*.example.com` 通配）、
  最近存活时间（30 分钟新鲜度窗口）、当前负载（连接数/容量上限，85% 过载线）、有效准入占用。
- 有效性边界以**采样时刻**为准：负载估算记录 `负载采样时刻`，权重来源记录代理池档案「分配权重」
  字段的采样时刻快照，排班切换班次不会沿用上一班次的结论。
- 预检通过才把代理实例/地址/准入编号回写连接器详情；预检失败只追加拒绝记录并保留连接器原状态。
- 准入记录只追加不覆盖：同连接器再次通过时旧有效记录置「已失效-被新预检替代」；代理回收、
  连接器离线时相关有效记录置「已失效」并留痕失效原因与时刻，历史接入结果不被改写。
- 预检在进程锁内串行完成「评估+占位」，多入口争用同一代理时只有一份通过，其余返回可复核的
  不可分配原因。独立视图与运营概览看板均按「准入拒绝 → 准入通过 → 已失效」排列。

领域：数据工程
子方向：数据采集、爬虫与RPA
