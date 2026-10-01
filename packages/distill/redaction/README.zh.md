---
description: "蒸馏产物的密钥脱敏：用字面量密钥环与模式规则对字符串或 JSON 值做一次遍历，使任何被记录的 stdout、轨迹或归档会话日志都不会未脱敏地落盘。"
kind: "package-reference"
---

# @deepseek-ai/dsh-distill-redaction

[English](README.md) | 中文

## 概述

使用 `dsh-distill-redaction` 从蒸馏运行即将持久化的任何内容中移除密钥。脱敏器隐藏调用方自己的值（即 *keyring*，密钥环）以及众所周知的凭据形态——PEM 私钥、`Bearer` 与 `Authorization` 值、`sk-` 密钥，以及 `api_key` 赋值——把每次命中替换为带类型的占位符，例如 `[REDACTED:API_KEY]`。`redactValue` 会脱敏嵌套在 JSON 值中的每个字符串，这正是轨迹与归档日志落盘前所取的形态。

脱敏对每个字符串只做一次遍历，且绝不重新扫描替换结果，因此重复应用是幂等的。它是零依赖库：没有插件，也没有 I/O。

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

每次运行构建一个脱敏器，并让每个值在写入之前都经过它。

### 脱敏字符串

```ts
import { collectEnvironmentSecrets, createRedactor } from '@deepseek-ai/dsh-distill-redaction'

const redactor = createRedactor({ secrets: collectEnvironmentSecrets() })
const { value, counts } = redactor.redact(`DEEPSEEK_API_KEY=sk-live-abcdefghijklmnop`)
// value  === 'DEEPSEEK_API_KEY=[REDACTED:API_KEY]'
// counts === { byRule: { 'sk-key': 1 }, total: 1 }
```

### 脱敏 JSON 值

```ts
import { createRedactor } from '@deepseek-ai/dsh-distill-redaction'

declare const event: Record<string, unknown>
const redactor = createRedactor({ secrets: ['a-configured-value'] })
const { value } = redactor.redactValue(event)
```

`redactValue` 返回新结构；输入绝不会被修改。

### 选择隐藏什么

| 选项 | 含义 |
|---|---|
| `secrets` | 在任何模式规则之前匹配的字面量值。短于 `MIN_SECRET_LENGTH` 的值会被忽略，重复项会合并。 |
| `disable` | 要从 `DEFAULT_REDACTION_RULES` 中去除的规则 id。未知 id 为空操作。 |

`collectEnvironmentSecrets(env?)` 从环境构建密钥环：名称必须匹配 `SECRET_NAME_PATTERN`，不得以非密钥后缀（`_PATH`、`_FILE`、`_NAME`、`_LENGTH` 等）结尾，且其值必须达到 `MIN_SECRET_LENGTH`。它返回值；它不写入任何内容。

### 默认规则

| id | 占位符 | 匹配 |
|---|---|---|
| `private-key` | `[REDACTED:PRIVATE_KEY]` | 完整的 `-----BEGIN … PRIVATE KEY-----` 块，含换行 |
| `bearer` | `[REDACTED:BEARER]` | `Bearer <credential>` |
| `authorization-header` | `[REDACTED:AUTHORIZATION]` | `Authorization:` 之后的值，不区分大小写 |
| `sk-key` | `[REDACTED:API_KEY]` | `sk-` 后跟至少八个凭据字符 |
| `secret-assignment` | `[REDACTED:SECRET]` | `api_key` / `apikey` / `api-key` 赋值的值 |

字面量命中在 `LITERAL_RULE_ID`（`'literal'`）下报告，并使用 `[REDACTED:SECRET]`。

### 需要规划的失败

当输入包含环时，`redactValue` 会抛出 `TypeError`。带环的值不是 JSON，而它供给的产物是 JSON，因此遍历会直接拒绝，而不是让一个失控的结构耗尽进程。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

脱敏分两个阶段执行，因此任何匹配器都不会在每个输入位置被求值，这正是恶意的 200 000 字符输入能在毫秒而非分钟内完成的原因。

### 第一阶段：定位候选

每个匹配器从自己的游标向前扫描。字面量匹配器在循环中使用 `indexOf`；规则匹配器通过 `exec` 使用其全局 `RegExp`。零宽匹配会被丢弃，正则游标前进一个位置，因此扫描不会空转。每个定位到的区间成为一个 `Hit`，携带其 start、end、规则 id、占位符与 `rank`。

`rank` 是匹配器在列表中的位置，用于编码优先级：字面量密钥在前，最长的优先，随后是按表格顺序排列的规则。

### 第二阶段：应用胜出命中

命中先按 start 排序，再按 rank 排序。一次从左到右的扫描会应用每个 start 位于已应用结束位置或其后的命中，并跳过其余命中，因此外层命中内部的内层命中绝不会进入输出。对真实命中而言，按 `(start, rank)` 排序是全序——同一个匹配器绝不会在同一索引处产生两个命中，而字面量匹配器按位置排序——因此扫描是确定性的，无需打破平局的键。

由于匹配由其自身的匹配器发现，而不是在每个偏移处尝试所有匹配器，开销与输入长度加上命中数成线性关系。由于替换结果写入输出列表且输入从不被重写，占位符不会再次被匹配：对已包含 `[REDACTED:API_KEY]` 的输出再做脱敏不会改变任何内容。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 全部接口面：匹配器准备、两阶段扫描与 JSON 遍历 |
| — | 不发布运行时不变式伴生入口。本包不拥有事件流或可变运行时状态，其替换约定由单元测试覆盖。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

本包是蒸馏流水线的脱敏边界。决定*写什么*的记录器与决定*写到哪里*的运行器是各自独立的包。

-----

<a id="model-experience"></a>
## 模型体验

无：脱敏运行在已记录的值与存储它的文件之间。

#### KV Cache 影响

此处没有任何内容进入请求前缀，因此提供方缓存复用不受影响。
## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **模式在召回率与附带误伤之间取舍。** 宽到能捕获所有凭据格式的模式会脱敏普通散文。默认值偏向精确：密钥环尚未包含的未知密钥形态不会被脱敏。请把运行被授权看到的确切值作为 `secrets` 传入。
- **密钥环的可靠性取决于其来源。** `collectEnvironmentSecrets` 只能看到传给它的环境。通过其他途径（读取文件、凭据存储）到达进程的密钥必须显式通过 `secrets` 提供。
- **脱敏不是检测。** `counts` 报告被替换了什么；它并不断言没有敏感内容残留。
- **没有流式形态。** 该 API 接受字符串或 JSON 值，因此读取任意大流的调用方必须自行分片，并接受跨越分片边界的密钥会被漏掉。

<a id="dev-note"></a>
### 开发备注

无。
