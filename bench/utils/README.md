# bench/utils — benchmark harness 公共模块

被 `bench/hle` 与 `bench/tb4` 共同引用的**行为中立**纯模块（从 hle 抽离）。

| 文件 | 内容 | 来源 |
|---|---|---|
| `env.js` | 读取 myco state `.env` 的模型+代理配置（`parseDotEnv`/`applyEnv`/`modelInfo`） | 原 `bench/hle/lib/config.js`（原样） |
| `http-server.js` | HTTP 服务骨架：`createPool`/`readBody`/`respond`/`descendantPids`/`installShutdown` | 原 `bench/hle/server.js`（原样，`installShutdown` 封装原 shutdown 逻辑） |
| `orch.py` | 编排辅助：`http_post`/重试退避/`Progress`/`LiveStatus`/增量 `save`/`persist`/`md_escape`/`parse_ids`/`load_questions`/`default_out` | 原 `bench/hle/run.py`（原样，仅对引用 HLE 常量的 `default_out`/`init_save` 加了参数） |

约束：只放字节级行为相同的纯函数；hle/tb4 各自引擎、判分、loader、报表逻辑留在各自目录。
改这些公共模块时确保 hle、tb4 都不受影响。
