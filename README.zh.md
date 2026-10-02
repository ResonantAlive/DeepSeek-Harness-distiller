# DeepSeek-Harness-distiller

[English](README.md) | 中文

让**教师模型**去真实任务里干活，把它做题的**每一步**录下来，最后得到一份带标签的训练数据集 —— 给将来训练学生模型用。

录的不是只有最终答案，而是**过程**：看到什么 → 想了什么 → 调了什么工具 → 工具返回什么 → 怎么改 → 怎么收尾。

这份文档带你从头跑通第一个任务。跟着做大约 10 分钟。

## 你需要准备什么

| 需要 | 说明 |
|---|---|
| **Node.js** | 版本要 `^22.19` 或 `>=24`。跑 `node -v` 看一下 |
| **pnpm** | 包管理器。`pnpm -v` 能出版本号就行 |
| **DeepSeek API 密钥** | 从 [platform.deepseek.com](https://platform.deepseek.com) 申请，形如 `sk-...` |
| **磁盘空间** | 大约 3 GB（依赖装完 2 GB 出头） |

<a id="run"></a>
## 运行

<a id="run-from-source"></a>

### 从源码运行

**第 1 步：拿到代码并装依赖**

```bash
git clone https://github.com/ResonantAlive/DeepSeek-Harness-distiller.git
cd DeepSeek-Harness-distiller
pnpm install
```

`pnpm install` 会跑几分钟，正常。

**第 2 步：构建**

```bash
pnpm run build:lib:host
```

⚠️ **这一步不能省。** 应用跑的是构建出来的 `lib/` 产物，不是 `src/` 里的源码。**改了源码不重新构建，运行结果不会变** —— 这是最容易踩的坑。

**第 3 步：配置密钥**

在项目根目录建一个 `.env` 文件：

```bash
DEEPSEEK_API_KEY=sk-your-key-here
```

⚠️ **不要设置 `DEEPSEEK_BASE_URL`。** 默认值就是对的（`https://api.deepseek.com/anthropic`）。填成裸域名会走错接口协议，报错很难看懂。

`.env` 已经在 `.gitignore` 里，不会被提交上去。

**第 4 步：写第一个任务**

一个"语料"长这样，三个文件夹各管一件事：

```
my-corpus/
├── tasks/
│   ├── manifest.yml
│   └── T01.yml
├── templates/
│   └── hello/
│       └── README.md
└── evaluator/
```

- `tasks/manifest.yml` —— 任务清单
- `tasks/T01.yml` —— 一个任务：题目 + 怎么判卷
- `templates/hello/` —— 初始工作区，**每次尝试都从这儿复制一份干净的**
- `evaluator/` —— 判卷用的隐藏文件，**模型看不到**（这个例子用不上）

`tasks/T01.yml` 的内容：

```yaml
version: 1
task_id: T01
prompt: |
  Create a file named hello.txt in the current directory.
  Its contents must be exactly the single word: hello
  Then you are done. Do not explain.
workspace:
  template: hello
evaluator:
  kind: test_command
  command:
    - node
    - -e
    - "process.exit(require('node:fs').readFileSync('../workspace/hello.txt','utf8').trim()==='hello'?0:1)"
```

`tasks/manifest.yml` 的内容：

```yaml
version: 1
tasks:
  - file: T01.yml
```

`templates/hello/` 里随便放一个文件：

```bash
mkdir -p my-corpus/templates/hello
echo "A scratch workspace." > my-corpus/templates/hello/README.md
```

⚠️ **注意判卷命令里的 `../workspace/`。** 判卷程序的运行目录是 `evaluator/`，**不是**工作区。要读模型产出的文件，得先往上走一层再进 `workspace/`。写成 `hello.txt` 会一直判失败。

**第 5 步：开始运行**

```bash
pnpm run distill --manifest my-corpus/tasks/manifest.yml --out my-corpus/dataset --templates my-corpus/templates
```

三个参数分别是：任务清单、结果输出目录、模板目录。`--evaluators` 只有用到隐藏判卷文件时才需要。

跑起来大概长这样：

```
host: 8 CPU (os), 24128 MB (os)
T01: SUCCESS attempts=1 -> success/T01
```

第一行是探测到的机器资源。第二行是结果：**任务成功，用了几次尝试，存到哪个目录**。

## 看结果

跑完 `my-corpus/dataset/` 里会是这样：

```
dataset/
├── index.jsonl
├── success/
│   └── T01/
│       └── trajectory.json
├── abandoned/
├── invalid/
└── failed/
    └── T01/
        ├── attempt_001/trajectory.json
        └── attempt_002/trajectory.json
```

- `index.jsonl` —— 所有任务的索引，每行一条
- `success/` —— 判成功的任务
- `abandoned/` —— 重试用完还是没成功的
- `invalid/` —— 判不了的（比如判卷程序坏了）
- `failed/` —— **每次失败的尝试，单独归档**（任务本身可能在别的桶里）

打开 `success/T01/trajectory.json`，里面是一次尝试的完整记录：

- `teacher` —— 是哪个模型干的（含 `served_model`，也就是**实际**服务的模型）
- `trajectory[]` —— 一步一步的过程，每步有 `observations`（看到什么）、`decision`（想了什么）、`actions`（调了什么工具）
- `artifacts` —— 改了哪些文件，以及**文件内部改了什么**（统一 diff）
- `evaluation` —— 判卷结果和原因

**关键点：成功和失败的数据都保留。** 失败不是垃圾 —— 学生模型正是从"这样做不行"里学到东西的。

## 任务文件详解

### prompt：题目

用自然语言说清楚要干什么。**要描述"可检查的结果"，不要描述"做法"。**

```yaml
prompt: Refactor this function to use async/await
```

上面这种不好判。换成下面这种：

```yaml
prompt: Make load() return a Promise that resolves to the parsed data
```

原因：你写不出判据的要求，模型也做不对 —— 因为双方都不知道"做对了"长什么样。

### workspace：初始工作区

```yaml
workspace:
  template: hello
```

`template` 指向 `templates/` 下的哪个文件夹。**每次尝试都会重新复制一份干净的**，上一次的改动不会带到下一次。

也可以额外塞文件进去：

```yaml
workspace:
  template: hello
  seed_files:
    - path: data/input.txt
      content: |
        listen
```

### evaluator：怎么判卷

**判卷绝不去问模型"你做完了吗"** —— 而是真的去跑命令、看结果。

```yaml
evaluator:
  kind: test_command
  command: [node, -e, "..."]
  timeout_ms: 60000
  expect_exit_code: 0
  assets: [verify.mjs]
```

| 字段 | 说明 |
|---|---|
| `kind` | `test_command` / `hidden_test` / `artifact_check` |
| `command` | 非空字符串数组。**退出码 0 = 通过，非 0 = 失败** |
| `timeout_ms` | 可选。超时后会记为基础设施故障，**不算模型的错** |
| `expect_exit_code` | 可选，默认就是 0 |
| `assets` | 可选。从 `evaluator/T01/` 拷进来的隐藏文件 |
| `expect_stdout_contains` | 可选。输出里必须含这个字符串 |

三种固定套路：

| 想判什么 | 怎么写 |
|---|---|
| 文件内容对不对 | `node -e` 读文件比对 |
| 代码能不能跑 | 跑测试套件，看退出码 |
| 结果对不对 | 跑一个校验脚本 |

**要写复杂判据时**，把脚本放 `evaluator/T01/verify.mjs`，然后用 `assets` 引进来。这个文件**模型看不到**，所以模型没法改它来"让自己通过"。

```yaml
evaluator:
  kind: hidden_test
  command: [node, verify.mjs]
  assets: [verify.mjs]
```

判据脚本里访问工作区，同样要写 `../workspace/`：

```js
const ws = new URL('../workspace/', import.meta.url)
const out = readFileSync(new URL('hello.txt', ws), 'utf8').trim()
if (out !== 'hello') {
  console.error(`hello.txt contains ${JSON.stringify(out)}, expected "hello"`)
  process.exit(1)
}
```

**`console.error` 的内容会存进数据集。** 所以失败原因写清楚，以后看失败样本时一眼就知道为什么。

## 常见问题

**Q：改了代码没生效？**

重新构建：`pnpm run build:lib:host`。应用跑的是 `lib/`，不是 `src/`。

**Q：一直 ABANDONED，但模型明明做了？**

八成是判卷路径写错了。判卷程序的运行目录是 `evaluator/`，工作区在 `../workspace/`。

去 `dataset/failed/T01/attempt_001/trajectory.json` 里看 `evaluation.entries[].stderr`，失败原因就写在那儿。

**Q：报密钥相关的错？**

检查三点：`.env` 里变量名是 `DEEPSEEK_API_KEY`；**没有**设置 `DEEPSEEK_BASE_URL`；密钥没过期。

**Q：怎么只跑其中一个任务？**

```bash
pnpm run distill --manifest my-corpus/tasks/manifest.yml --out my-corpus/dataset --templates my-corpus/templates --task T01
```

**Q：想一次跑很多任务，怎么控制并发？**

```bash
pnpm run distill --manifest my-corpus/tasks/manifest.yml --out my-corpus/dataset --templates my-corpus/templates --max-concurrent-tasks 4
```

程序会先探测机器实际资源（容器里会读 cgroup 限制，比机器标称值小），**装不下的并发方案会直接拒绝启动**，而不是跑到一半被系统杀掉。

**Q：跑太慢了？**

调 `--attempt-timeout-ms`（单次尝试的超时）和 `--max-concurrent-tasks`。另外任务定义里可以限制单次尝试的步数和 token。

## 下一步

**写判据是核心工作，也是最花时间的部分。** 几条经验：

1. **先把判据写出来，再写 prompt。** 写不出判据的要求，就别放进 prompt。
2. **只需要覆盖"行为"，不需要覆盖"所有输入"。** 无穷个输入通常只对应六七种行为，每种测一个代表就够。
3. **边界是 bug 的藏身处**：空数组、单个元素、第一页和最后一页、正好整除、零和负数、中文和 emoji。
4. **别把格式和风格放进判据。** 那会让模型因为跟任务无关的事被判失败，标签就脏了。

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证列在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
