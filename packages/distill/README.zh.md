---
description: "教师轨迹蒸馏的包映射：密钥脱敏、单教师锁、实时事件捕获、attempt 运行器与数据集写入器，以及宿主资源划分。"
kind: "package-group"
---

# distill/：教师轨迹蒸馏

[English](README.md) | 中文

## 概述

`distill/` 组记录教师模型在求解任务过程中的行为，使结果可用于训练学生模型。一个包脱敏密钥，一个包把组合锁定到单一教师，一个包在 agent 工作时捕获事件，一个包运行 attempt 并依据任务声明的命令对其做出判定，还有一个包在运行开始前划分宿主资源。本组在磁盘上产出数据集；它不新增 Harness 服务，由 `apps/distill` 应用驱动。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

每个包负责一次运行中的一个阶段；打开对应包页面了解如何使用。

| 包 | 职责 |
|---|---|
| [`redaction/`](redaction/README.zh.md) | 在任何被记录的字节落盘之前，把密钥值替换为带类型的占位符 |
| [`teacher-lock/`](teacher-lock/README.zh.md) | 在加载时拒绝可能服务于锁定教师之外模型的组合 |
| [`trajectory-events/`](trajectory-events/README.zh.md) | 订阅会话事件与流事件，写出脱敏的事件日志以及内容寻址的 blob |
| [`distill/`](distill/README.zh.md) | 加载任务定义、运行相互独立的 attempt、对其进行客观判定，并写出带标签的数据集 |
| [`resource/`](resource/README.zh.md) | 探测容器实际允许的 CPU 与内存，并拒绝超额分配的资源划分 |

-----

<a id="related-documentation"></a>
## 相关文档

- [`apps/distill`](../../apps/distill) 把这些包组合成运行语料库的应用。

<a id="dev-note"></a>
### 开发备注

无。
