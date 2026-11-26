# 原理图脚本工具

[`eda-step.js`](eda-step.js) 是**单步**驱动嘉立创 EDA 专业版的脚本：每次调用只做一件事
（放一个器件、画一根线、放一个端口/标签），结果立刻返回、可由调用方校验。
设计原则是「一次只走一小步」，便于出错时定位到具体操作。

## 调用方式

EDA 桌面版运行时自带 CLI。脚本是一个 async 函数体，`eda` 在作用域内：

```powershell
$exe = 'C:\Program Files\lceda-pro\lceda-pro.exe'
$sid = '<session-id>'          # 由 lceda-pro open / session 命令给出
$cf  = Join-Path $env:TEMP 'step.js'
Set-Content -LiteralPath $cf -Value $code -Encoding UTF8
$out = Join-Path $env:TEMP 'step.out'
$p = Start-Process -FilePath $exe -ArgumentList @('invoke','--session',$sid,'--code-file',$cf) `
     -NoNewWindow -PassThru -RedirectStandardOutput $out
$p.WaitForExit(180000) | Out-Null
Get-Content $out -Raw
```

取当前 session：`& $exe session list`；打开工程：`& $exe open --path <工程.eprj3>`。

## 动作一览（`op` 字段）

| op | 作用 | 关键参数 |
| --- | --- | --- |
| `page` | 新建/清空图页 | `name`、`keep:true`（保留其它页） |
| `wipe` | 清空当前页 | — |
| `place` | 放器件并回读实际引脚坐标 | `ref`、`device`（**精确库名**）、`x`、`y`、`rot` |
| `pin` | 查某个器件的引脚 | `ref`、`name` |
| `wire` | 折线 | `via:[[x,y],…]`、`net`（只传第一段，整组继承） |
| `port` | 网络端口 | `x`、`y`、`net`、`dir`(IN/OUT/BI)、`side`(R/D/L/U) |
| `label` | 网络标签 | `x`、`y`、`net` |
| `gnd` / `pwr` | 地 / 电源符号 | `x`、`y`、`rot` |
| `delwire` | 按端点删线 | `seg:[x1,y1,x2,y2]` |
| `delcomp` | 按位号删器件 | `ref` |
| `delattr` | 按网络+窗口删标签 | `net`、`x`、`y`、`rx`、`ry` |
| `verify` | 输出网表（网络→引脚） | — |
| `overlaps` | 检查图元重叠 | — |
| `frame` / `text` / `snap` | 图框 / 文本 / 截图 | — |

## 已知坑（都实测过）

1. **放置后必须回读引脚坐标**：器件引脚不在锚点中心，例如 `AO3401` 的 S/D 在 `x+10`。按假设坐标画线会**差 10 单位对接不上**，而且肉眼看不出来，只有网表能发现。
2. **地符号本体从锚点向下延伸约 25 单位**，而 IC 引脚间距只有 10 → 必须先横移 ≥50 再向下。
3. **建线偶尔会被拒**（同样坐标单独跑却成功）：连续快速创建时编辑器网络合并逻辑冲突 → 重试 3~4 次、间隔 200~400ms。
4. **折线每段都带 net 会渲染出两份网络名** → 只给第一段。
5. **端口节距 ≥12**（端口体 31×11，引脚间距 10 放不下）；10 间距的引脚用**网络标签**（文字高 8）而不是端口。
6. **网表可能整个返回空、截图返回旧帧**：窗口被遮挡/最小化导致渲染停摆 → `lceda-pro activate`；仍不行就 `session close --session <sid> --destroy` 后重新 `open`。
7. **位号冲突会被静默改号**（U1→U3），建页后要回读校验。

## 更多

完整方法论（端口语义、扇出规则、器件几何表、逐块验证流程）见项目 skill：
[`.agents/skills/easyeda-schematic`](../../.agents/skills/easyeda-schematic/SKILL.md)。