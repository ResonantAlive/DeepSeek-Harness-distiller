# DeepSeek-Harness-distiller

[English](README.md) | 中文

这个项目基于 DeepSeek-Harness（dsh `0.2.0-rc.2`），在上面加了一套教师模型轨迹蒸馏的功能：让强模型去真实任务里干活，把过程录下来，最后得到一份带标签的训练数据集。

这份文档只讲一件事：跟原版比，我们动了哪些地方。

文中的数字都是从 git 里取的，可以自己核对。基线是导入上游发布树的那次提交，所以这里用提交信息来找它，而不写死标识符：

```bash
BASE=$(git log --format=%H --grep='pristine dsh' --max-count=1)
git log --oneline "$BASE..HEAD"
git diff --shortstat "$BASE..HEAD"
git diff --name-status "$BASE..HEAD"
```

## 先说结论

原版的手写源码一共只动了 6 个文件，大约 120 行，全部是新增，没有删除，也没有改变原来的行为。剩下的内容都是新包、新应用和测试。

那条基线就是 0.2.0-rc.2 的发布树，14,104 个文件。之后共 33 次提交，改动 104 个文件，其中 73 个是新增（包含 13 个测试文件）。另外有 2 个文件是生成产物，重跑生成器就行，不用手改。

## 动了原版的 6 个文件

改核心代码有风险，所以这部分逐个说明。

### 1. `packages/llm/llm/src/types.ts`

流式协议里的 `usage` 分片多了一个可选字段 `servedModel`：

```diff
- | { type: 'usage'; usage: TokenUsage }
+ | {
+   type: 'usage'
+   usage: TokenUsage
+   servedModel?: string
+ }
```

请求里写的模型名，和实际响应的模型不一定是同一个，别名、路由部署都可能造成差别。数据集要说清楚轨迹是谁产出的，就得把这个记下来。

### 2. `packages/llm/llm-deepseek/src/translate.ts`

原版在解析响应时把 `message.model` 丢掉了。我们把它读出来，通过上面那个字段往上传：

```diff
+ let servedModel: string | undefined
- updateUsage(usage, object(event.message).usage)
+ const message = object(event.message)
+ updateUsage(usage, message.usage)
+ if (typeof message.model === 'string' && message.model.length > 0) servedModel = message.model
- yield { type: 'usage', usage }
+ yield { type: 'usage', usage, ...servedModel === undefined ? {} : { servedModel } }
```

这个信息只有适配器这一层拿得到，插件层看不到，所以只能在这里改。

### 3. `packages/shell/tool-bash/src/index.ts`

给 bash 工具加了一个 `presentationMeta`，把命令的结构化结果写进工具结果的元数据里，模型看不到这部分：

```
shell, command, workdir, exit_code, signal,
timed_out, aborted, timeout_ms, stdout, stderr
```

模型看到的是合并后的一段文本，stdout 和 stderr 混在一起，退出码只是文本里的一个标记，这是给人读的。数据集需要的是机器能直接用的东西：退出码、分开的两个流、是不是被信号杀掉的。

`ToolResult.meta` 是框架本来就有的字段，文档里写明会原样存进 `tool/result`，也不在模型可见的内容里。所以这处改动不会影响模型输入，也不会让快照测试变化。

### 4. `packages/shell/tool-pwsh/src/index.ts`

和上一条同样的改动。两个工具都要改，是跑真实 API 测试时发现的：在 Windows 上模型用的是 `pwsh`，不是 `bash`。如果只改 `tool-bash`，Windows 机器上这部分信息就全是空的。

### 5. `packages/boot/app-boot/src/index.ts`

把 `distill-teacher-lock` 加进了「必须启动成功」的名单：

```diff
+ // A composition that mounts the teacher lock must not start when the lock
+ // refuses it, or a run would record trajectories attributed to the wrong model.
+ 'distill-teacher-lock',
```

如果没有这一条，教师锁拒绝启动之后应用还会继续跑，最后录出一整份归属错误的轨迹。我们希望配置有问题时直接报错停下来，而不是悄悄跳过。

### 6. `packages/boot/app-boot/src/profile.ts`

注册一个新 profile，这样才能用 `dsh --profile distill` 启动：

```diff
+ distill: { bundles: ['@deepseek-ai/dsh-base'] },
```

### 生成产物

- `packages/extensions/tool-cordis/src/api-catalog.ts`：Cordis 服务目录，新增的 `ctx.distillCapture` 会被生成进去
- `packages/preset/agent-preset/skills/cordis-composition-reference/references/packages.md`：插件包清单，同理

除了上面这些，根 `package.json` 加了一条脚本，用来启动蒸馏应用：

```diff
+ "distill": "node --import tsx/esm apps/distill/src/bin.ts",
```

## 为什么这几处没法绕开

- `served_model` 只有适配器知道，`message.model` 在 `translate.ts` 里就被丢了，别的地方拿不到。
- 命令的结束状态只有 shell 工具自己清楚，从外面只能拿到合并后的文本。
- 教师锁要靠启动装配来保证「拒绝就停机」，这正是 `requiredStartupEntryIds` 的用途，放在普通插件里做不到。

除此之外的功能，全部是通过新增插件实现的，没有再改原版。

## 新增的部分

### 五个包

`packages/distill/` 下新增了五个包：

| 包 | 做什么 |
|---|---|
| `redaction` | 落盘之前把密钥换成占位符，覆盖原文、blob、轨迹和归档会话 |
| `teacher-lock` | 加载时就拒绝可能服务到非锁定模型的组合 |
| `trajectory-events` | 订阅会话和流事件，写出脱敏后的原始事件日志，以及按内容寻址的 blob |
| `distill` | 读取任务定义，跑相互独立的尝试，客观判定结果，写出带标签的数据集 |
| `resource` | 探测容器实际允许的 CPU 和内存，装不下的切分方案直接拒绝 |

### 一个应用

`apps/distill/` 是驱动整个流程的应用：

- `composition.ts`：通过 Cordis Loader 组装（`loadProfile` + `createRuntimeResolution` + `PluginPackages` + `boot`），没有手写 `ctx.plugin(...)`
- `agent-runner.ts`：生产用的 `AgentRunner`，负责建会话、发消息、等空闲（带超时）、落盘
- `bin.ts`：命令行入口，处理参数、限流、资源校验，然后逐个任务执行

另外有一个真实 API 测试（`tests/real-agent.spec.ts`），没配密钥时会自动跳过。

### 文档

- [`docs/subsystems/distill.zh.md`](docs/subsystems/distill.zh.md)：蒸馏子系统的参考页，讲捕获服务的约定、轨迹文档、数据集分桶和主机切分
- [`docs/persistence-changes/2026-10-02-served-model-optional.zh.md`](docs/persistence-changes/2026-10-02-served-model-optional.zh.md)：持久化类型变更的双语确认记录

## 验证情况

| 项目 | 结果 |
|---|---|
| `pnpm run doc-sync` 文档检查 | 43 / 43 通过 |
| 五个新包的覆盖率（每个文件 100%） | 5 / 5 通过 |
| 新增包和应用的单测 | 355 个通过 |
| 真实 API 端到端 | 3 / 3 通过 |
| `tsc -b tsconfig.host.json` | 退出码 0 |
| `packages/shell/tool-pwsh` 自带测试 | 100 个通过 |

真实 API 的三个用例分别是：判定成功、判定永远不通过、超出预算。三个都用真实凭据跑过，没有密钥时会自动跳过。

<a id="run"></a>
## 运行

应用实际跑的是 `lib/` 里的构建产物。改了 `src/` 之后要先重新构建，真实链路里才能看到改动：

```bash
pnpm run build:lib:host
```

<a id="run-from-source"></a>
### 从源码运行

```bash
pnpm install

node node_modules/vitest/vitest.mjs run packages/distill

node node_modules/vitest/vitest.mjs run packages/distill/distill \
  --coverage --coverage.include='packages/distill/distill/src/**'

pnpm run doc-sync

DEEPSEEK_API_KEY=<key> node node_modules/vitest/vitest.mjs run apps/distill/tests/real-agent.spec.ts
```

## 已知的限制

- **`tool-bash` 自带的测试在我们的开发机上跑不了。** `packages/shell/tool-bash/tests/**` 被排在 vitest 之外（开发机是 Windows，没有 bash）。这部分改动目前只靠类型约束和调用方的测试覆盖，完整的测试需要在 Linux 上跑。
- **判据没有独立沙箱。** 评估器和 runner 在同一个进程里。防作弊靠运行前后比对指纹，能发现被改动，但做不到进程隔离。
- **`thinking` 开关没有记录。** 它在适配器的线格式里，不在 `LlmCallConfig` 里。轨迹里记的是 `reasoning_available`，也就是实际有没有拿到思考内容。
- **还没做的：** 会话日志的脱敏销毁、崩溃恢复、配置优先级链。

## 相关文档

- [蒸馏子系统参考](docs/subsystems/distill.zh.md)：捕获服务、一次尝试记录的内容、数据集分桶和主机切分
- [持久化类型变更记录](docs/persistence-changes/2026-10-02-served-model-optional.zh.md)：`servedModel` 字段的兼容性说明
- [安全说明](SAFETY.zh.md)：运行本项目前请先阅读
- [参与贡献](CONTRIBUTING.zh.md)

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证列在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
