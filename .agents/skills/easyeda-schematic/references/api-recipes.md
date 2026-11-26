# API 配方（本机 v4.1.105 实测）

单位：**原理图 1 单位 = 0.01 inch = 10 mil**。PCB 域是 1 mil。A4 横向画布约 `1169 × 827`，
`y` 向上（数值越大越靠上）。

## 打开工程 / 执行代码

```powershell
& 'C:\Program Files\lceda-pro\lceda-pro.exe' open --path '<abs>/x.eprj3'
& 'C:\Program Files\lceda-pro\lceda-pro.exe' invoke --session <SID> --code-file <abs>/build.js --timeout 240000
```

`--code` 走命令行（~32KB 上限），大脚本用 `--code-file`。

代码体是 async 函数体，`eda` 在作用域内，`return` 的结果进 JSON 的 `value`。

## 放置与属性

```js
const dev = (await eda.lib_Device.search('TP4056')).find(d => d.name === 'TP4056');
const c = await eda.sch_PrimitiveComponent.create(dev, x, y, undefined, rotation, mirror, true, true);
const id = c.getState_PrimitiveId();
await eda.sch_PrimitiveComponent.modify(id, { designator: 'U3' });   // 位号必须合法
const pins = await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(id);
// pin: { pinNumber, pinName, x, y, ... }（坐标已是绝对坐标）
```

## 导线

```js
await eda.sch_PrimitiveWire.create([x1, y1, x2, y2]);              // 单段
await eda.sch_PrimitiveWire.create([x1,y1, x2,y2, x3,y3]);         // 折线
await eda.sch_PrimitiveWire.create([x1, y1, x2, y2], 'NET_NAME');  // 整组继承该网络名
```

- 只接受水平/垂直段；微斜（浮点误差）会被拒。
- 零长度段被拒。
- 同网络且首尾相接的导线会并成**一个 WIRE 组**（`getAllPrimitiveId()` 返回的是组数，不是段数）。

## 电源 / 地符号

```js
await eda.sch_PrimitiveComponent.createNetFlag('Power',  'VBAT', x, y, rotation, false);
await eda.sch_PrimitiveComponent.createNetFlag('Ground', 'GND',  x, y, 0, false);
```

- Power `rotation 0`：引脚在**下**方（线从下方接上来）。`rotation 180`：引脚在上方。
- Ground `rotation 0`：引脚在**上**方（线从上方接下来）。
- 符号必须**精确落在导线端点**，差 1 个单位就是断的。
- 多个同名符号 = 同一网络。

## 网络标签

```js
await eda.sch_PrimitiveAttribute.createNetLabel(x, y, 'ADC_DIV');   // 放在线头端点上
```

## 图形与文字

```js
await eda.sch_PrimitiveRectangle.create(topLeftX, topLeftY, width, height, cornerRadius, rotation, color, fillColor, lineWidth, lineType, fillStyle);
await eda.sch_PrimitiveText.create(x, y, 'A. USB-C 输入', 0, '#2F4858', null, 15, true, false, false);
```

## 网表（自检的唯一真相）

```js
const nl = JSON.parse(await eda.sch_Netlist.getNetlist());
// nl.components['<uid>'].props.Designator
// nl.components['<uid>'].pinInfoMap['<pin>'].net
```

异步：写完图元后等 ~900ms 再读，或单独跑一次只读脚本。

## 页面 / 原理图管理

```js
await eda.dmt_Schematic.getAllSchematicPagesInfo();
await eda.dmt_EditorControl.openDocument(pageUuid);            // 返回 tabId
await eda.dmt_EditorControl.waitForDocumentReady(tabId, 30000);
await eda.dmt_Schematic.modifySchematicName(schUuid, 'Name');  // 不能含空格
await eda.sch_Document.save();
const blob = await eda.dmt_EditorControl.getCurrentRenderedAreaImage(tabId); // 截图
```

## 清空当前页

```js
for (const [get, del] of [
  ['getAllPrimitiveId', null],
]) {}
// 顺序：属性 → 导线 → 文字 → 矩形 → 器件
await eda.sch_PrimitiveAttribute.delete(await eda.sch_PrimitiveAttribute.getAllPrimitiveId());
await eda.sch_PrimitiveWire.delete(await eda.sch_PrimitiveWire.getAllPrimitiveId());
await eda.sch_PrimitiveText.delete(await eda.sch_PrimitiveText.getAllPrimitiveId());
await eda.sch_PrimitiveRectangle.delete(await eda.sch_PrimitiveRectangle.getAllPrimitiveId());
await eda.sch_PrimitiveComponent.delete(await eda.sch_PrimitiveComponent.getAllPrimitiveId());
```
