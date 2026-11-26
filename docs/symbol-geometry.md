
# 嘉立创 EDA 专业版 元件符号几何表

- 客户端：C:\Program Files\lceda-pro\lceda-pro.exe，v4.1.105，运行中；session id 8a36430f-5f18-480b-a323-b04a29b66a9b
- 坐标系：原理图坐标系，1 单位 = 0.01 inch = 10 mil = 0.254 mm
- 取数接口：eda.lib_Device.search(<名>) 模糊搜索 → find(d => d.name === <名>) 精确过滤 → eda.lib_Symbol.getGeometry(symbolUuid, libraryUuid)
- 20 个器件全部一次精确命中（exactCount = 1），getGeometry 全部返回有效几何，因此没有用到"临时图页放置"的退路方案
- 另做了一次独立校验（见附录 B.3）：在自己新建的临时图页上真实放置 TYPE-C-16PIN / TP4056 / SS-12F45G4-RS，用 getAllPinsByPrimitiveId 读绝对坐标，与"锚点 + getGeometry 相对坐标"逐一对比，31 个引脚全部完全相等（误差 0）。校验后图页已 deleteSchematicPage 删除。

> 结论先行：getGeometry 的 pins[].x/y 与 fullBBox/bodyBBox 可以直接与器件放置锚点相加，无需翻转 Y 轴（符号源码 esym 里的 BBOX 是另一套 Y 方向，getGeometry 已经归一化过）。

---

## 1. 主表

| 器件名 | 脚数 | fullBBox 宽×高 | bodyBBox 宽×高 | 引脚分布（边:脚数） | 同边相邻间距 | 备注 |
|---|---:|---|---|---|---|---|
| TYPE-C-16PIN | 17 | 100×130 | 80×130 | 左8 / 右8 / 上1 | 左:10/30；右:10/30 | 17 脚 = 16 信号 + 1 个外壳脚 EH（顶上）；左右各 8 脚且完全对称；GND 脚被推远 30（非 10） |
| USBLC6-2SC6 | 6 | 90×40 | 70×40 | 左3 / 右3 | 左:10；右:10 |  |
| TP4056 | 9 | 100×60 | 80×60 | 左4 / 右5 | 左:10；右:10 | 9 脚含 EP（脚 9，右侧最上 y=+20），左侧只有 4 脚 |
| RT9080-33GJ5 | 5 | 80×40 | 60×40 | 左3 / 右2 | 左:10；右:20 | 右侧 NC/VOUT 间距 20（跳过中间位），不是 10 |
| AO3401 | 3 | 28.5×40 | 22.5×24 | 左1 / 上1 / 下1 | —（每边仅 1 脚） | G 在左，S 在下，D 在上；三点不对称，fullBBox 中心偏 +4.25 |
| AO3400 | 3 | 33.5×40 | 26×21 | 左1 / 上1 / 下1 | —（每边仅 1 脚） | G 在左（脚长 8，不是 10），S 在下，D 在上；中心偏 -3.25 |
| SS14 | 2 | 40×16 | 14×16 | 左1 / 右1 | —（每边仅 1 脚） | K 左 / A 右；脚长 15（长脚），bodyBBox 很窄 |
| LED-0603 | 2 | 40×26.5 | 15×26 | 左1 / 右1 | —（每边仅 1 脚） | 两脚都在 y=-10（不在锚点水平线上）；- 左 / + 右 |
| 10K | 2 | 40×8 | 20×8 | 左1 / 右1 | —（每边仅 1 脚） | 普通电阻，两脚 y=0 对称 |
| 1k | 2 | 40×10 | 20×10 | 左1 / 右1 | —（每边仅 1 脚） | 普通电阻 |
| 100k | 2 | 40×8 | 20×8 | 左1 / 右1 | —（每边仅 1 脚） | 普通电阻 |
| 200k | 2 | 40×8 | 20×8 | 左1 / 右1 | —（每边仅 1 脚） | 普通电阻 |
| 92J2K4E | 2 | 40×10 | 20×10 | 左1 / 右1 | —（每边仅 1 脚） | 插件电阻（TH） |
| CFR-25JR-52-5K1 | 2 | 40×10 | 20×10 | 左1 / 右1 | —（每边仅 1 脚） | 插件电阻（TH） |
| 10uf | 2 | 40×21 | 14.5×21 | 左1 / 右1 | —（每边仅 1 脚） | 脚长 17/19 不等长；bodyBBox 14.5 宽，位移大 |
| 100nF | 2 | 40×17 | 21×17 | 左1 / 右1 | —（每边仅 1 脚） | 注意脚号反了：左脚是 2、右脚是 1 |
| 1nF-C0603 | 2 | 40×17 | 21×17 | 左1 / 右1 | —（每边仅 1 脚） | 常规电容 |
| 1uF50V5x11GF | 2 | 40×15.03 | 21×15.03 | 左1 / 右1 | —（每边仅 1 脚） | 高度 15.03（非整数），上下各偏 0.015 |
| 2P-P3.81_KF2EDGV-3.81-2P | 2 | 30×30 | 20×30 | 左2 | 左:10 | 两脚都在左侧同一列；中心偏 -5 |
| SS-12F45G4-RS | 5 | 30×80 | 20×60 | 左3 / 上1 / 下1 | 左:10 | 左 3 脚 + 上 1 + 下 1，上下两脚在 x=+5（不在中线）；中心偏 -5 |


---

## 2. uuid 与包围盒明细（含锚点偏移）

"fullBBox 中心 − 锚点"一列表示包围盒几何中心相对器件锚点的偏移。它不为 0 时，不能用"半宽 + 半宽"来算间距，必须用第 3 节的公式。

| 器件名 | 符号 uuid | symbol 库 uuid | 器件 uuid | fullBBox min→max | bodyBBox min→max | fullBBox 中心−锚点 |
|---|---|---|---|---|---|---|
| TYPE-C-16PIN | 82c5048755134a7e9c624662132c58ac | 0819f05c4eef4c71ace90d822a990e87 | 9f13c156ab864763858f62761224479e | (-50,-60)→(50,70) | (-40,-60)→(40,70) | (0,5) |
| USBLC6-2SC6 | e5c8198e70f04987968abe2e8a11202b | 0819f05c4eef4c71ace90d822a990e87 | 1e5e214711544da8ba71fb2137ae703f | (-45,-20)→(45,20) | (-35,-20)→(35,20) | (0,0) |
| TP4056 | 589ca6f8c9994f1e995f44c63b6ab938 | 0819f05c4eef4c71ace90d822a990e87 | 72b7171a34974d9b9a48555d7ee01359 | (-50,-30)→(50,30) | (-40,-30)→(40,30) | (0,0) |
| RT9080-33GJ5 | 9a4915a2290f45c38690cc300e7f7795 | 0819f05c4eef4c71ace90d822a990e87 | ab07d656abe944dca5dc58806c54f3ac | (-40,-20)→(40,20) | (-30,-20)→(30,20) | (0,0) |
| AO3401 | b5e8b945067d4cc9a722a3c2d21cdc96 | 0819f05c4eef4c71ace90d822a990e87 | 5979b416d8ff45958b92bd9285da1c98 | (-10,-20)→(18.5,20) | (-4,-11.58)→(18.5,12.42) | (4.25,0) |
| AO3400 | 7e5269b1fdec4df88e6be52baf9dee59 | 0819f05c4eef4c71ace90d822a990e87 | 156c84fad5b14ff593fe1de7d78d1d0a | (-20,-20)→(13.5,20) | (-12.5,-10.5)→(13.5,10.5) | (-3.25,0) |
| SS14 | 868d7eda91ec4868aafcc3a013be2fae | 0819f05c4eef4c71ace90d822a990e87 | 573dbc1c89204bb4a69bdba708192c88 | (-20,-7.5)→(20,8.5) | (-8.5,-7.5)→(5.5,8.5) | (0,0.5) |
| LED-0603 | 1755d660eb5640ac904c42988d91df20 | 0819f05c4eef4c71ace90d822a990e87 | 8079e603b53f42ca8378d6083f42dcbb | (-20,-10)→(20,16.5) | (-9.5,-9.5)→(5.5,16.5) | (0,3.25) |
| 10K | bf84e1a8c6f045318cfe111656574c78 | 0819f05c4eef4c71ace90d822a990e87 | 071b1112f6ac47bf85f8490b437f9ef0 | (-20,-4)→(20,4) | (-10,-4)→(10,4) | (0,0) |
| 1k | 321a0e8cae68452ea1f3e172f36b6e12 | 0819f05c4eef4c71ace90d822a990e87 | 216221df24314fdba52f354454af9ece | (-20,-5)→(20,5) | (-10,-5)→(10,5) | (0,0) |
| 100k | c34ebc971c4149568471050fb4bdbd1a | 0819f05c4eef4c71ace90d822a990e87 | 76d594ed2a534354bf539349d6785789 | (-20,-4)→(20,4) | (-10,-4)→(10,4) | (0,0) |
| 200k | bba07baa93254439abc999d1f9770407 | 0819f05c4eef4c71ace90d822a990e87 | f81f9380217546d093d7c71f61228f7d | (-20,-4)→(20,4) | (-10,-4)→(10,4) | (0,0) |
| 92J2K4E | cdd96479526e442c860e8cb4b2628ed4 | 0819f05c4eef4c71ace90d822a990e87 | 1799d6b7b25f4c9fa9180115a03063ec | (-20,-5)→(20,5) | (-10,-5)→(10,5) | (0,0) |
| CFR-25JR-52-5K1 | 685ce900ea544a159784ce71a9fad937 | 0819f05c4eef4c71ace90d822a990e87 | 872a06b373b2499481a7f61f63f73533 | (-20,-5)→(20,5) | (-10,-5)→(10,5) | (0,0) |
| 10uf | 130f5764886a46f88d2b85cd3981dca1 | 0819f05c4eef4c71ace90d822a990e87 | 6bcfe662b92d469dbde3ac3f1d8cf65a | (-20,-10.5)→(20,10.5) | (-10,-10.5)→(4.5,10.5) | (0,0) |
| 100nF | 9debf7bf302c4e3984465c0349e14bf6 | 0819f05c4eef4c71ace90d822a990e87 | ff8480c1170c4ddfbf5ae09830d3b6e5 | (-20,-8.5)→(20,8.5) | (-10.5,-8.5)→(10.5,8.5) | (0,0) |
| 1nF-C0603 | ff1d83d21cda424190a9c707a7021333 | 0819f05c4eef4c71ace90d822a990e87 | 8319cd80ed8c45ba92639f8b8bcee421 | (-20,-8.5)→(20,8.5) | (-10.5,-8.5)→(10.5,8.5) | (0,0) |
| 1uF50V5x11GF | b832af62f1534ee9aa9e35aad3ee0bb2 | 0819f05c4eef4c71ace90d822a990e87 | ae3d43698ab04939b5ad7be19fc9736b | (-20,-7.53)→(20,7.5) | (-10.5,-7.53)→(10.5,7.5) | (0,-0.015) |
| 2P-P3.81_KF2EDGV-3.81-2P | e53ff96b134f49e1b453a7585a914442 | 0819f05c4eef4c71ace90d822a990e87 | 49de4d21e4f94a21a084aa84a39a0032 | (-20,-15)→(10,15) | (-10,-15)→(10,15) | (-5,0) |
| SS-12F45G4-RS | 5c929a87fa3348ac90efe3eaab595b24 | 0819f05c4eef4c71ace90d822a990e87 | 12cb52b91b6f4247a2d1eaba1c22c067 | (-20,-40)→(10,40) | (-10,-30)→(10,30) | (-5,0) |


### 关于引脚栅格

- 所有多脚边的相邻引脚间距只有 10 / 20 / 30 三种，全部是 10 的整数倍，没有非整数栅格间距。
- 但引脚连接点坐标本身有两个半格特例（50 mil 栅格，不是 100 mil）：
  - SS-12F45G4-RS 的上/下两脚在 x = +5
  - 2P-P3.81_KF2EDGV-3.81-2P 的两脚在 y = ±5

  这两个器件连线时端点必须用原始坐标，不能四舍五入到 10 的倍数。
- AO3401 / AO3400 的 bbox 出现 28.5 / 18.5 / 11.58 这类半整数值，来自 MOSFET 的箭头/沟道图形，不是引脚坐标；这两个器件的引脚坐标仍然是整 10 的倍数。

---

## 3. 结论：并排摆放的最小中心距

按 fullBBox 算，取最宽的那一类：两个器件并排（同一行、锚点 Y 相同）时，锚点中心距至少 100 单位 = 1000 mil = 25.4 mm。

推导：最宽的是 TYPE-C-16PIN 和 TP4056，fullBBox 都是 x ∈ [−50, +50]（宽 100，且锚点正好在水平中点）。
左件锚点 0 → 占 [−50, +50]；右件锚点 d → 占 [d−50, d+50]。不重叠要求 d − 50 ≥ 50，即 d ≥ 100。

竖直堆叠（同一列、锚点 X 相同）：至少 130 单位 = 1300 mil = 33.02 mm（TYPE-C-16PIN 高 130，y ∈ [−60, +70]）。

### 严格公式（任意两个器件 A、B，锚点 a、b）

```
水平并排（同一行）：   b.x - a.x  >=  A.fullBBox.maxX  -  B.fullBBox.minX
竖直堆叠（同一列）：   a.y - b.y  >=  B.fullBBox.maxY  -  A.fullBBox.minY
```

同款器件相邻时化简为 d ≥ 宽（水平）或 d ≥ 高（竖直）。

### 各类型建议间距

| 类型 | 器件 | 水平最小 | 水平建议(+10) | 竖直最小 | 竖直建议(+10) |
|---|---|---:|---:|---:|---:|
| Type-C 母座 | TYPE-C-16PIN | 100 | 110 | 130 | 140 |
| ESOP-8 | TP4056 | 100 | 110 | 60 | 70 |
| SOT-23-6 | USBLC6-2SC6 | 90 | 100 | 40 | 50 |
| TSOT-23-5 | RT9080-33GJ5 | 80 | 90 | 40 | 50 |
| SOT-23-3 | AO3400 | 33.5 | 45 | 40 | 50 |
| SOT-23-3 | AO3401 | 28.5 | 40 | 40 | 50 |
| SOD-323 | SS14 | 40 | 50 | 16 | 26 |
| LED 0603 | LED-0603 | 40 | 50 | 26.5 | 36.5 |
| 0805 电阻 | 10K / 100k / 200k | 40 | 50 | 8 | 18 |
| 0603 电阻 | 1k | 40 | 50 | 10 | 20 |
| 插件电阻 | 92J2K4E / CFR-25JR-52-5K1 | 40 | 50 | 10 | 20 |
| 贴片电容 | 10uf | 40 | 50 | 21 | 31 |
| 插件电容 | 100nF / 1nF-C0603 | 40 | 50 | 17 | 27 |
| 插件电解 | 1uF50V5x11GF | 40 | 50 | 15.03 | 25.03 |
| 端子 2P | 2P-P3.81_KF2EDGV-3.81-2P | 30 | 40 | 30 | 40 |
| 拨动开关 | SS-12F45G4-RS | 30 | 40 | 80 | 90 |

> 上表"最小"是包围盒刚好相切（引脚端面顶在一起），电气上不算重叠，但没有走线空间；实际布局请用"建议"列，或在 10 单位栅格上取整。
> 另外多个器件的锚点不在包围盒中心（SS-12F45G4-RS 与 2P-P3.81 中心偏 −5，AO3401 偏 +4.25，AO3400 偏 −3.25，LED-0603 竖直偏 +3.25），混排时请回上面的公式，别用半宽相加。

---

## 4. 三个最容易摆错的器件

### 4.1 TYPE-C-16PIN —— 17 脚（16 信号 + 1 外壳 EH）

- fullBBox = [−50,−60] → [50,70]，100 × 130
- bodyBBox = [−40,−60] → [40,70]，80 × 130
- 两者竖向范围完全一样（都是 −60 … +70），说明 EH 脚没有伸出本体顶部，它的连接点正好落在本体上边缘 y = +70
- 分布：左 8 / 右 8 / 上 1，左右两列 Y 坐标完全对称

左列（Y 从小到大）：

| 脚号 | 名 | x | y |
|---|---|---:|---:|
| 8 | GND | −50 | −60 |
| 7 | VBUS | −50 | −30 |
| 6 | SBU1 | −50 | −20 |
| 5 | DN1 | −50 | −10 |
| 4 | DP1 | −50 | 0 |
| 3 | CC1 | −50 | +10 |
| 2 | VBUS | −50 | +20 |
| 1 | GND | −50 | +50 |

右列（Y 从小到大）：9 GND(−60) / 10 VBUS(−30) / 11 CC2(−20) / 12 DP2(−10) / 13 DN2(0) / 14 SBU2(+10) / 15 VBUS(+20) / 16 GND(+50)，x 全为 +50。

顶上 1 脚：17 EH at (0, +70)，rot 90（朝上），脚长 10。

间距特征：每列相邻 Y 差值 = 30, 10, 10, 10, 10, 10, 30。只有最外两端是 30（= 3 × 10），中间 6 段全是 10。即脚 2…7 挤在 y = −30 … +20 的连续 10 栅格上，而脚 1（+50）和脚 8（−60）各自被推开 30。

摆位要点：

1. 上方必须留 EH（还要留 10 的引脚长度 + 走线），否则一放上去就顶到上一排符号；只按左右预留会漏掉它。
2. 左右各 8 根 10 长引脚，占位宽度是 100 不是本体 80；按 80 排会压线。
3. 4 个 GND（y = −60 / +50）与 4 个 VBUS（y = −30 / +20）落在两组不同的 Y 上，不是等距的，做电源分支时不能按"均匀分布"假设。

### 4.2 TP4056 —— 9 脚（8 + EP）

- fullBBox = [−50,−30] → [50,30]，100 × 60
- bodyBBox = [−40,−30] → [40,30]，80 × 60
- 分布：左 4 / 右 5 —— 左右脚数不对称

| 边 | 脚（Y 从小到大） |
|---|---|
| 左 (x = −50) | 4 VCC(−20) / 3 GND(−10) / 2 PROG(0) / 1 TEMP(+10) |
| 右 (x = +50) | 5 BAT(−20) / 6 STDBY(−10) / 7 CHRG(0) / 8 CE(+10) / 9 EP(+20) |

间距：两侧内部都是连续 10，左侧 3 段、右侧 4 段。

最容易错的地方：EP（脚 9）不在器件下方，而是接在右侧最上方 y = +20，与 8 号 CE 只隔 10。 如果按"散热焊盘在底下"的直觉去排，会完全对不上符号；而且 EP 与 CE 相邻，CE 的控制线会被 EP 的地铜/走线挤住，建议 CE 先往右引再折。

左侧只到 y = +10，右侧到 +20，所以左边上方比右边空出一格，符号视觉重心偏左下。

### 4.3 SS-12F45G4-RS —— 5 脚

- fullBBox = [−20,−40] → [10,40]，30 × 80
- bodyBBox = [−10,−30] → [10,30]，20 × 60
- 分布：左 3 / 上 1 / 下 1（四个方向占了三个）

| 边 | 脚 | 坐标 |
|---|---|---|
| 左 (x = −20) | 3 / 2 / 1 | y = −10 / 0 / +10（间距 10） |
| 上 | 4 | (+5, +40)，rot 90 |
| 下 | 5 | (+5, −40)，rot 270 |

三处坑：

1. 上/下两脚在 x = +5，不在中线 x = 0 —— 是 50 mil 半格，不是 10 的倍数，连线端点必须用原始坐标。
2. 锚点不在包围盒中心：fullBBox 的 X 只到 −20 … +10，几何中心在 x = −5。若按"宽 30 居中"摆放，整体会右移 5，左边那 3 根线就会压到左侧相邻器件。
3. 竖向 80 高（±40），是这批器件里第二高的（仅次于 TYPE-C 的 130）；而本体只有 60（±30），上下各有 10 的引脚区，上下都要预留。

---

## 附录 A：逐脚原始坐标（全部 20 个器件）

坐标一律为相对器件锚点的原理图单位（10 mil）。同一行内按所在边的坐标从小到大排列。

### TYPE-C-16PIN

```
[左边 8 脚] #8 @(-50,-60)  #7 @(-50,-30)  #6 @(-50,-20)  #5 @(-50,-10)  #4 @(-50,0)  #3 @(-50,10)  #2 @(-50,20)  #1 @(-50,50)
[右边 8 脚] #9 @(50,-60)  #10 @(50,-30)  #11 @(50,-20)  #12 @(50,-10)  #13 @(50,0)  #14 @(50,10)  #15 @(50,20)  #16 @(50,50)
[上边 1 脚] #17 @(0,70)
```

### USBLC6-2SC6

```
[左边 3 脚] #3 @(-45,-10)  #2 @(-45,0)  #1 @(-45,10)
[右边 3 脚] #4 @(45,-10)  #5 @(45,0)  #6 @(45,10)
```

### TP4056

```
[左边 4 脚] #4 @(-50,-20)  #3 @(-50,-10)  #2 @(-50,0)  #1 @(-50,10)
[右边 5 脚] #5 @(50,-20)  #6 @(50,-10)  #7 @(50,0)  #8 @(50,10)  #9 @(50,20)
```

### RT9080-33GJ5

```
[左边 3 脚] #3 @(-40,-10)  #2 @(-40,0)  #1 @(-40,10)
[右边 2 脚] #4 @(40,-10)  #5 @(40,10)
```

### AO3401

```
[左边 1 脚] #1 @(-10,0)
[上边 1 脚] #3 @(10,20)
[下边 1 脚] #2 @(10,-20)
```

### AO3400

```
[左边 1 脚] #1 @(-20,0)
[上边 1 脚] #3 @(0,20)
[下边 1 脚] #2 @(0,-20)
```

### SS14

```
[左边 1 脚] #1 @(-20,0)
[右边 1 脚] #2 @(20,0)
```

### LED-0603

```
[左边 1 脚] #1 @(-20,-10)
[右边 1 脚] #2 @(20,-10)
```

### 10K

```
[左边 1 脚] #1 @(-20,0)
[右边 1 脚] #2 @(20,0)
```

### 1k

```
[左边 1 脚] #1 @(-20,0)
[右边 1 脚] #2 @(20,0)
```

### 100k

```
[左边 1 脚] #1 @(-20,0)
[右边 1 脚] #2 @(20,0)
```

### 200k

```
[左边 1 脚] #1 @(-20,0)
[右边 1 脚] #2 @(20,0)
```

### 92J2K4E

```
[左边 1 脚] #1 @(-20,0)
[右边 1 脚] #2 @(20,0)
```

### CFR-25JR-52-5K1

```
[左边 1 脚] #1 @(-20,0)
[右边 1 脚] #2 @(20,0)
```

### 10uf

```
[左边 1 脚] #1 @(-20,0)
[右边 1 脚] #2 @(20,0)
```

### 100nF

```
[左边 1 脚] #2 @(-20,0)
[右边 1 脚] #1 @(20,0)
```

### 1nF-C0603

```
[左边 1 脚] #1 @(-20,0)
[右边 1 脚] #2 @(20,0)
```

### 1uF50V5x11GF

```
[左边 1 脚] #1 @(-20,0)
[右边 1 脚] #2 @(20,0)
```

### 2P-P3.81_KF2EDGV-3.81-2P

```
[左边 2 脚] #2 @(-20,-5)  #1 @(-20,5)
```

### SS-12F45G4-RS

```
[左边 3 脚] #3 @(-20,-10)  #2 @(-20,0)  #1 @(-20,10)
[上边 1 脚] #4 @(5,40)
[下边 1 脚] #5 @(5,-40)
```



---

## 附录 B：实际跑通的代码

### B.1 调用外壳（PowerShell，本机实测可用）

```powershell
$code = @'
...js...
'@
$cf = Join-Path $env:TEMP 'sym.js'
Set-Content -LiteralPath $cf -Value $code -Encoding UTF8
$out = Join-Path $env:TEMP 'sym.out'; $err = Join-Path $env:TEMP 'sym.err'
$p = Start-Process -FilePath 'C:\Program Files\lceda-pro\lceda-pro.exe' -ArgumentList @(
  'invoke','--session','8a36430f-5f18-480b-a323-b04a29b66a9b',
  '--code-file',$cf,'--timeout','180000'
) -NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
$p.WaitForExit(240000) | Out-Null
Get-Content $out -Raw
```

返回体形如 `{"ok":true,"value":...,"logs":[],"durationMs":1330}`。要点：`--code` 有约 32 KB 命令行上限，批量脚本一律走 `--code-file`；`ok:true` 只代表代码跑完、不代表业务结果，所以脚本里自己 throw。

### B.2 取几何（对 20 个器件一次跑完，实际用的就是这段）

```javascript
const NAMES = ['TYPE-C-16PIN','USBLC6-2SC6','TP4056','RT9080-33GJ5','AO3401','AO3400',
  'SS14','LED-0603','10K','1k','100k','200k','92J2K4E','CFR-25JR-52-5K1','10uf','100nF',
  '1nF-C0603','1uF50V5x11GF','2P-P3.81_KF2EDGV-3.81-2P','SS-12F45G4-RS'];
const out = [];
for (const nm of NAMES) {
  const rec = { name: nm };
  const res = await eda.lib_Device.search(nm);
  const hits = res.filter(d => d.name === nm);
  rec.exactCount = hits.length;
  if (!hits.length) { rec.error = 'NO_EXACT_MATCH'; out.push(rec); continue; }
  const d = hits[0];
  rec.deviceUuid    = d.uuid;
  rec.symbolUuid    = d.symbolUuid || (d.symbol && d.symbol.uuid);
  rec.symbolLibUuid = (d.symbol && d.symbol.libraryUuid) || d.libraryUuid;
  const g = await eda.lib_Symbol.getGeometry(rec.symbolUuid, rec.symbolLibUuid);
  if (!g) { rec.error = 'GEOMETRY_UNDEFINED'; out.push(rec); continue; }
  rec.fullBBox = g.fullBBox;
  rec.bodyBBox = g.bodyBBox;
  rec.pins = g.pins.map(p => ({ num: p.pinNumber, name: p.pinName, side: p.side,
                                rot: p.rotation, x: p.x, y: p.y, len: p.length }));
  out.push(rec);
}
return out;
```

`side` 取值 `left/right/top/bottom`，由 `rotation` 归并：`0→right、90→top、180→left、270→bottom`。注意 `rotation` 是引脚朝外方向（与 esym 源码里的 `rotation` 相差 180°）。

### B.3 独立校验（在自己新建的临时图页上放置后读绝对引脚）

这是全程唯一"放器件"的操作，只碰自己建的页，结束即删：

```javascript
const dev = { libraryUuid:'0819f05c4eef4c71ace90d822a990e87',
              uuid:'9f13c156ab864763858f62761224479e',
              symbolUuid:'82c5048755134a7e9c624662132c58ac' };
const log = []; let pageUuid = null; const out = {};
try {
  const cur = await eda.dmt_SelectControl.getCurrentDocumentInfo();
  if (!cur || cur.documentType !== 1) throw new Error('no schematic page active');
  const pi = await eda.dmt_Schematic.getSchematicPageInfo(cur.uuid);
  pageUuid = await eda.dmt_Schematic.createSchematicPage(pi.parentSchematicUuid);
  await new Promise(r => setTimeout(r, 900));

  let ok = false, tries = 0;
  while (!ok && tries < 3) {
    tries++;
    await eda.dmt_EditorControl.openDocument(pageUuid);
    await new Promise(r => setTimeout(r, 700));
    const d = await eda.dmt_SelectControl.getCurrentDocumentInfo();
    ok = !!(d && d.uuid === pageUuid);
    log.push('activate try' + tries + ' ok=' + ok);
  }
  if (!ok) throw new Error('could not activate my own page');

  const ax = 2000, ay = 3000;
  const comp = await eda.sch_PrimitiveComponent.create(dev, ax, ay);
  const pid  = comp.getState_PrimitiveId();
  const pins = await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(pid);
  const g    = await eda.lib_Symbol.getGeometry(dev.symbolUuid, dev.libraryUuid);
  const gmap = {}; for (const p of g.pins) gmap[p.pinNumber] = p;
  out.pins = pins.map(p => {
    const num = p.getState_PinNumber(), gg = gmap[num];
    return { num, absX: p.getState_X(), absY: p.getState_Y(),
             dX: p.getState_X() - ax, dY: p.getState_Y() - ay,
             gX: gg.x, gY: gg.y,
             ok: Math.abs((p.getState_X() - ax) - gg.x) < 1e-6 &&
                 Math.abs((p.getState_Y() - ay) - gg.y) < 1e-6 };
  });
} finally {
  if (pageUuid) log.push('deletePage=' + await eda.dmt_Schematic.deleteSchematicPage(pageUuid));
}
return { log, out };
```

实测返回（节选 TYPE-C-16PIN，锚点 2000,3000）：

```
activate try1 ok=true
deletePage=true

#17 EH   abs=(2000,3070)  d=(0,70)    geo=(0,70)    ok=True
#16 GND  abs=(2050,3050)  d=(50,50)   geo=(50,50)   ok=True
#1  GND  abs=(1950,3050)  d=(-50,50)  geo=(-50,50)  ok=True
#7  VBUS abs=(1950,2970)  d=(-50,-30) geo=(-50,-30) ok=True
#8  GND  abs=(1950,2940)  d=(-50,-60) geo=(-50,-60) ok=True
...（共 17 脚，全部 ok=True）
```

三个器件合计 31 脚，31/31 全部相等。临时图页 48208e9cd1dfe9d7 已删除，未触碰他人的页。
