# 网络端口（IN / OUT / BI）精确语义

来源：`exp-port` 子任务实测（12/12 连通、4/4 断开的正反双向验证，含像素级截图）。

## 1. 锚点就是传入的 (x, y)

`createNetPort(kind, net, x, y, rotation, mirror)` 的电气连接点**永远是传入的 (x,y)**，
四个 rotation 都一样。端口只有一个引脚，`pinName` 就是 `IN`/`OUT`/`BI`。

- 导线端点精确落在 (x,y) → 连通（实测 12/12）
- 端点差 20 单位 → 落到匿名网 `$7Nxx`（实测 4/4 断开）

**目视判据**：端口引脚位置会画一个约 3 单位直径的**灰色小圆点**（未连接标记），接上线即消失。

## 2. rotation 对照表（★ 与直觉相反，务必按此表）

`IN` 与 `OUT/BI` 的图形是**镜像**的，同一 rotation 朝向相反。
**`createNetPort('OUT'|'BI', …, r)` ≡ `createNetPort('IN', …, r+180)`。**

| 类型 | rotation | 图形本体在锚点的 | 文字在 | **导线必须从** |
|---|---|---|---|---|
| IN | 0 | −X（左） | 左 | **右（+X）** |
| IN | 90 | +Y（上） | 上（竖排，自下而上） | **下（−Y）** |
| IN | 180 | +X（右） | 右 | **左（−X）** |
| IN | 270 | −Y（下） | 下（竖排，自上而下） | **上（+Y）** |
| OUT / BI | 0 | +X（右） | 右 | **左（−X）** |
| OUT / BI | 90 | −Y（下） | 下 | **上（+Y）** |
| OUT / BI | 180 | −X（左） | 左 | **右（+X）** |
| OUT / BI | 270 | +Y（上） | 上 | **下（−Y）** |

实用映射（`side` = 导线从锚点哪一侧进来）：

```js
const ROT_IN  = { R: 0,   D: 90,  L: 180, U: 270 };
const ROT_OUT = { R: 180, D: 270, L: 0,   U: 90  };  // OUT/BI 同此
```

**导线从错误的一侧进来，端口本体和网名就会压在这根导线上**（实测截图里文字被打穿、
甚至被相邻器件盖住）。这是「端口压线」的唯一成因。

## 3. OUT / BI 默认不显示网名（重要）

同一批参数创建的 8 个端口，只有 `IN` 出现文字，`OUT`/`BI` 没有。几何、字号完全一致，
差别只是**`Name` 属性的显示默认值**。必须显式打开：

```js
await eda.sch_SourcePrimitiveComponent.updateAttribute({
  projectId, schematicName, pageName,
  primitiveId: portId,
  key: 'Name',
  valueVisible: true,
  keyVisible: false,
});
```

**不打开就会出现「端口没名字」，而网络其实是对的**——很容易被误判成连接错误。

## 4. 尺寸与间距

| 项 | 数值（0.01 inch） |
|---|---|
| 图形本体 | 长边 40（含 10 引脚，轮廓 30）× 高 10 |
| 文字近端到锚点 | IN 45 / BI 45 / OUT 50 |
| 字高 / 字宽 | 6.25 / 约 3.7 每字符 |
| 加网名的总长 | 45~50 + 3.7 × 字符数 |

间距：两个端口**正面相对**中心距 ≥ **180**；同向单排 ≥ **120**。
按这个排，11 字符的网名也不会互相压。

## 5. 三个容易踩的测量/工具坑

1. **`getCurrentRenderedAreaImage` 忽略 `zoomToRegion`**：连拍得到字节完全相同的整画布图。
   要可标定的局部图用 `sch_Document.renderRegion({region:{minX,minY,maxX,maxY}, width, format:'png'})`，
   `region` 是页坐标、`width` 决定 px/单位。
2. **`sch_Netlist.getNetlist()` 的作用域跟当前激活页走**，不是全工程。
   换了页再读会得到另一批器件，别误判成「器件丢了」。
3. **位号撞名会静默改号**：在实验页上用 `R5` 这类已存在的位号，会被自动改成 `R12`。
   自建实验页请用不会撞的前缀。
