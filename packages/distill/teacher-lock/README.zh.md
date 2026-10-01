---
description: "蒸馏组合的加载期教师模型锁：在启动环境与组合之间解析出一次运行可使用的唯一模型，拒绝被放宽的允许列表，并在任何轨迹被记录之前失败。"
kind: "package-reference"
---

# @deepseek-ai/dsh-distill-teacher-lock

[English](README.md) | 中文

## 概述

蒸馏运行产出的每条轨迹都必须来自同一个教师模型，无法固定到单一模型的组合必须在记录任何内容之前失败。`dsh-distill-teacher-lock` 在组合加载时解析该模型，并在无法解析时拒绝运行：完全没有候选、两层指定了不同模型，或模型不在允许列表内。它同样拒绝接受任意模型的允许列表，因为接受一切的锁不是锁。

该判定是一个纯函数（`./lock` 中的 `resolveTeacherLock`）；插件只读取候选层并调用它。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在蒸馏组合中挂载它：

```yaml
- id: distill-teacher-lock
  name: '@deepseek-ai/dsh-distill-teacher-lock'
  config:
    allow: [deepseek-flash]
```

当组合无法被固定时该挂载会抛出异常，因此配置错误的运行会在加载时停止，而不是产出标注错误的数据。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `allow` | `deepseek-flash` 加上已退役的别名 | 该组合接受的模型 id。换用其他教师是一次有意为之的覆盖。 |
| `model` | 缺省 | 组合自身的模型，仅在启动环境未指定模型时参考。适配器的选择仍是权威。 |

### 锁定模型从何而来

候选按优先级顺序参考，第一个胜出：

| 顺序 | 层 | 来源 |
|---|---|---|
| 1 | `DSH_DISTILL_MODEL` | 启动环境 |
| 2 | `MODEL_NAME` | 启动环境 |
| 3 | `ctx.agentDefaultModel.currentSelection().model` | 组合 |
| 4 | 插件自身的 `model` | 组合 |

环境通过 `launchEnvironmentOf` 读取，与模型适配器解析变量所用的快照相同，因此锁与适配器不会对某个值来自哪一层产生分歧。

### 需要规划的失败

以下所有情况都会让挂载停止：

| 条件 | 代码 | 为何被拒绝 |
|---|---|---|
| 没有任何一层指定模型 | `model-not-allowed` | 没有可固定的对象 |
| 环境与组合指定了不同模型 | `model-not-allowed` | 一次运行固定到一位教师；静默选择任何一方都会标注错数据 |
| 所选模型不在 `allow` 中 | `model-not-allowed` | 该组合不接受这位教师 |
| `allow` 条目为空或含多余空白 | `model-not-allowed` | 该条目无法固定模型 |
| `allow` 为空 | `empty-allowlist` | 与「没有候选」不同：允许列表本身不可用 |
| `allow` 含 `*` | `allowlist-widened` | 接受任意模型属于被拒绝的放宽，而不是未知模型 |
| 所参考的变量已设置但为空 | `model-not-allowed` | 已设置但为空是配置错误，而不是值缺失 |

已退役的别名（`deepseek-v4-flash`、`deepseek-v4-flash-vision-exp`）会被**接受**并以警告级别记录，因为提供方仍会将其路由到当前教师；锁会报告 `legacy: true`，以便操作者更新已记录的 id。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`resolveTeacherLock` 先校验允许列表，再校验候选集，最后校验所选模型。顺序很重要：即使不存在任何候选，不可用的允许列表也按此报告，因为允许列表失败是更具体的事实。

放宽哨兵值先于空值与空白检查被检查，因此 `*` 报告 `allowlist-widened` 而不是通用代码——操作者需要知道某个组合试图接受任意模型，而不只是某个条目格式错误。

解析出的锁会复制其允许列表。持有传入数组的调用方无法在之后放宽一个仍在生效的锁。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/lock.ts`](src/lock.ts) | 全部判定：常量、允许列表校验器、冲突检测与解析 |
| [`src/index.ts`](src/index.ts) | Cordis 插件：读取两个候选层、解析、记录日志、在被拒绝时抛出异常 |
| — | 不发布运行时不变式伴生入口。锁在加载后不持有可变状态，其判定由单元测试完全覆盖。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

教师校验的运行时那一半——记录提供方实际服务的模型并标记不匹配——属于轨迹记录器，而不是本包：本包决定一次运行*可以*使用什么，记录器则证明一次运行*实际*使用了什么。

-----

<a id="model-experience"></a>
## 模型体验

无：锁在加载时校验组合配置，不注册任何提示词、工具或会话事件。

#### KV Cache 影响

此处没有任何内容进入请求前缀，因此提供方缓存复用不受影响。
## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **锁固定的是配置，不是流量。** 它拒绝配置中教师错误的组合。要证明某个响应来自被固定的模型，需要在每个响应上观察实际服务的模型，而本包不做这件事。
- **后续补丁可以替换该行。** 锁校验的是它加载时的配置。之后应用的补丁可以在不重新运行该校验的情况下改变适配器的模型；组合的层顺序正是防止这种情况的机制。
- **允许列表是策略，不是保证。** 默认拒绝 `deepseek-v4-pro` 只是因为默认允许列表指定了那位教师；刻意允许其他模型的组合会被尊重。
- **已退役的别名被接受，但不被改写。** 锁报告 `legacy: true` 并告警；它不会让运行失败，因为提供方仍为这些名称服务当前教师。

<a id="dev-note"></a>
### 开发备注

无。
