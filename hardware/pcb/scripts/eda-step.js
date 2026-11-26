// 单步原理图工具：每次调用只做一个动作，回报几何/状态，供逐步驱动
// 用法：lceda-pro invoke --session <SID> --code-file v2-step.js --args '{"op":"place",...}'
// 动作：place | pin | wire | port | gnd | pwr | frame | text | verify | overlaps | wipe | page
const A = (typeof __CLI__ !== 'undefined' && __CLI__.args) ? __CLI__.args : {};
const out = { op: A.op, steps: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const R = (v) => Math.round(v);

const need = (k) => { if (A[k] === undefined) throw new Error('missing arg: ' + k); return A[k]; };

// 按位号找已有器件
const allComps = async () => {
	const ids = (await eda.sch_PrimitiveComponent.getAllPrimitiveId()) || [];
	const list = [];
	for (const id of ids) {
		const c = await eda.sch_PrimitiveComponent.get(id);
		if (!c) continue;
		const des = c.getState_Designator ? c.getState_Designator() : null;
		const ty = c.getState_ComponentType ? c.getState_ComponentType() : null;
		list.push({ id, des, ty });
	}
	return list;
};
const find = async (ref) => {
	const l = await allComps();
	const hit = l.find((x) => x.des === ref);
	if (!hit) throw new Error('no component with designator ' + ref);
	return hit;
};
const pinsOf = async (id) => (await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(id)) || [];
const pin = async (ref, name) => {
	const c = await find(ref);
	const ps = await pinsOf(c.id);
	const nb = ps.filter((p) => String(p.pinName).toUpperCase() === String(name).toUpperCase());
	const hb = ps.filter((p) => String(p.pinNumber) === String(name));
	const h = nb[0] || hb[0];
	if (!h) throw new Error('no pin ' + ref + '.' + name + ' (have ' + ps.map((p) => p.pinNumber + ':' + p.pinName).join(',') + ')');
	return { n: h.pinNumber, nm: h.pinName, x: R(h.x), y: R(h.y) };
};
// 建线：快速连续创建会被暂时拒绝，重试 + 间隔
const wCreate = async (flat, net) => {
	for (let attempt = 0; attempt < 4; attempt++) {
		try {
			const w = await eda.sch_PrimitiveWire.create(flat, net || undefined);
			if (w) return w;
		} catch (e) { if (attempt === 3) throw e; }
		await sleep(220 + attempt * 180);
	}
	return null;
};
const seg = async (x1, y1, x2, y2) => {
	x1 = R(x1); y1 = R(y1); x2 = R(x2); y2 = R(y2);
	if (x1 === x2 && y1 === y2) return null;
	try {
		const w = await wCreate([x1, y1, x2, y2], A.net || undefined);
		if (!w) out.steps.push(`wUNDEF ${x1},${y1},${x2},${y2}`);
		return w ? w.getState_PrimitiveId() : null;
	} catch (e) { out.steps.push(`wERR ${x1},${y1},${x2},${y2} :: ${e.message}`); return null; }
};
// 元件包围盒（引脚极值 + 边距）
const compBox = async (ref) => {
	const c = await find(ref);
	const ps = await pinsOf(c.id);
	const xs = ps.map((p) => p.x), ys = ps.map((p) => p.y);
	return { ref, minX: R(Math.min(...xs)), maxX: R(Math.max(...xs)), minY: R(Math.min(...ys)), maxY: R(Math.max(...ys)) };
};

try {
	switch (A.op) {
		case 'page': {
			// 新建页并删除同原理图下其它页
			const schs = await eda.dmt_Schematic.getAllSchematicsInfo();
			const sch = (schs || []).find((s) => s.name === (A.schematic || 'TraceveilV2'));
			const pageUuid = await eda.dmt_Schematic.createSchematicPage(sch.uuid);
			const olds = A.keep ? [] : ((await eda.dmt_Schematic.getAllSchematicPagesInfo()) || [])
				.filter((p) => p.parentSchematicUuid === sch.uuid && p.uuid !== pageUuid);
			for (const p of olds) { try { await eda.dmt_Schematic.deleteSchematicPage(p.uuid); } catch (e) {} }
			const tab = await eda.dmt_EditorControl.openDocument(pageUuid);
			await eda.dmt_EditorControl.waitForDocumentReady(tab, 30000);
			await eda.dmt_EditorControl.activateDocument(tab);
			await sleep(400);
			const cur = await eda.dmt_SelectControl.getCurrentDocumentInfo();
			out.page = pageUuid;
			out.current = cur && cur.uuid;
			out.ok = !!(cur && cur.uuid === pageUuid);
			if (A.name) { try { await eda.dmt_Schematic.modifySchematicPageName(pageUuid, A.name); } catch (e) {} }
			break;
		}
		case 'wipe': {
			for (const n of ['sch_PrimitiveAttribute', 'sch_PrimitiveWire', 'sch_PrimitiveText', 'sch_PrimitiveRectangle', 'sch_PrimitiveComponent']) {
				try { const ids = (await eda[n].getAllPrimitiveId()) || []; if (ids.length) await eda[n].delete(ids); } catch (e) {}
			}
			out.ok = true;
			break;
		}
		case 'place': {
			const ref = need('ref'), devName = need('device');
			const x = need('x'), y = need('y');
			const res = (await eda.lib_Device.search(devName)) || [];
			const dev = res.find((d) => d.name === devName) || res.find((d) => d.name.toLowerCase() === devName.toLowerCase());
			if (!dev) throw new Error('device not found: ' + devName);
			const c = await eda.sch_PrimitiveComponent.create(dev, x, y, undefined, A.rot || 0, false, true, true);
			if (!c) throw new Error('create returned undefined');
			const id = c.getState_PrimitiveId();
			await eda.sch_PrimitiveComponent.modify(id, { designator: ref });
			const ps = await pinsOf(id);
			out.placed = {
				ref, device: dev.name, id,
				pins: ps.map((p) => ({ n: p.pinNumber, nm: p.pinName, x: R(p.x), y: R(p.y) })),
			};
			const xs = ps.map((p) => R(p.x)), ys = ps.map((p) => R(p.y));
			out.placed.box = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
			break;
		}
		case 'pin': {
			out.pin = await pin(need('ref'), need('name'));
			break;
		}
		case 'box': {
			out.box = await compBox(need('ref'));
			break;
		}
		case 'wire': {
			// via: [[x,y],[x,y],...] 或 from/to 引脚对
			if (A.from && A.to) {
				const a = await pin(A.from[0], A.from[1]);
				const b = await pin(A.to[0], A.to[1]);
				if (A.mode === 'vh') { await seg(a.x, a.y, a.x, b.y); await seg(a.x, b.y, b.x, b.y); }
				else { await seg(a.x, a.y, b.x, a.y); await seg(b.x, a.y, b.x, b.y); }
				out.wired = { a, b };
			} else {
				const via = need('via');
				// 网络名只加在第一段有效线段上（整组会继承），否则每段都渲染一份文字
				let named = false;
				for (let i = 0; i < via.length - 1; i++) {
					const x1 = R(via[i][0]), y1 = R(via[i][1]), x2 = R(via[i + 1][0]), y2 = R(via[i + 1][1]);
					if (x1 === x2 && y1 === y2) continue;
					const useNet = (!named && A.net) ? A.net : undefined;
					try {
						await eda.sch_PrimitiveWire.create([x1, y1, x2, y2], useNet);
						if (useNet) named = true;
					} catch (e) { out.steps.push(`wERR ${x1},${y1},${x2},${y2} :: ${e.message}`); }
				}
				out.via = via;
				out.namedFirst = named;
			}
			break;
		}
		case 'port': {
			// side = 导线从锚点哪一侧进来：R/L/U/D
			const x = need('x'), y = need('y'), net = need('net');
			const kind = A.dir || 'BI';
			const ROT_IN = { R: 0, D: 90, L: 180, U: 270 };
			const ROT_OUT = { R: 180, D: 270, L: 0, U: 90 };
			const side = A.side || 'R';
			const rot = (A.rot !== undefined) ? A.rot : (kind === 'IN' ? ROT_IN[side] : ROT_OUT[side]);
			const c = await eda.sch_PrimitiveComponent.createNetPort(kind, net, R(x), R(y), rot, false);
			const id = c ? c.getState_PrimitiveId() : null;
			out.port = { net, kind, side, rot, x: R(x), y: R(y), id };
			// OUT/BI 默认不显示网名，显式打开
			if (id) {
				try {
					const proj = await eda.dmt_Project.getCurrentProjectInfo();
					const sch = await eda.dmt_Schematic.getCurrentSchematicInfo();
					const cur = await eda.dmt_SelectControl.getCurrentDocumentInfo();
					const pg = await eda.dmt_Schematic.getSchematicPageInfo(cur.uuid);
					await eda.sch_SourcePrimitiveComponent.updateAttribute({
						projectId: proj.uuid,
						schematicName: sch.name,
						pageName: pg.name,
						primitiveId: id,
						key: 'Name',
						valueVisible: true,
						keyVisible: false,
					});
					out.port.nameVisible = true;
				} catch (e) { out.port.nameVisible = 'ERR ' + e.message; }
			}
			break;
		}
		case 'delcomp': {
			const ref = need('ref');
			const c = await find(ref);
			try { await eda.sch_PrimitiveComponent.delete([c.id]); out.delcomp = { ref, ok: true }; }
			catch (e) { out.delcomp = { ref, ok: false, err: e.message }; }
			break;
		}
		case 'delattr': {
			// 删除指定网络、且坐标落在窗口内的网络标签
			const net = need('net');
			const x0 = A.x === undefined ? -1e9 : A.x - (A.rx || 40);
			const x1 = A.x === undefined ? 1e9 : A.x + (A.rx || 40);
			const y0 = A.y === undefined ? -1e9 : A.y - (A.ry || 40);
			const y1 = A.y === undefined ? 1e9 : A.y + (A.ry || 40);
			const attrs = (await eda.sch_PrimitiveAttribute.getAll()) || [];
			let removed = 0;
			for (const a of attrs) {
				try {
					const ax = a.getState_X ? a.getState_X() : null;
					const ay = a.getState_Y ? a.getState_Y() : null;
					const an = a.getState_Net ? a.getState_Net() : null;
					if (ax === null || an !== net) continue;
					if (ax < x0 || ax > x1 || ay < y0 || ay > y1) continue;
					await eda.sch_PrimitiveAttribute.delete([a.getState_PrimitiveId()]);
					removed++;
				} catch (e) {}
			}
			out.delattr = { net, removed };
			break;
		}
		case 'delwire': {
			// A.seg = [x1,y1,x2,y2]；删除端点匹配的导线（无向匹配）
			const s = need('seg').map(Number);
			const key = (a, b, c, d) => [a, b, c, d].join(',');
			const want = [key(s[0], s[1], s[2], s[3]), key(s[2], s[3], s[0], s[1])];
			const all2 = (await eda.sch_PrimitiveWire.getAll()) || [];
			let removed = 0;
			for (const w of all2) {
				const line = w.getState_Line ? w.getState_Line() : null;
				if (!line) continue;
				const l = line.map(Number);
				for (let i = 0; i + 3 < l.length; i += 2) {
					if (want.includes(key(l[i], l[i + 1], l[i + 2], l[i + 3]))) {
						try { await eda.sch_PrimitiveWire.delete([w.getState_PrimitiveId()]); removed++; } catch (e) { out.steps.push('delERR ' + e.message); }
						break;
					}
				}
			}
			out.delwire = { seg: s, removed };
			break;
		}
		case 'label': {
			const x = need('x'), y = need('y'), net = need('net');
			try {
				const a = await eda.sch_PrimitiveAttribute.createNetLabel(R(x), R(y), net);
				out.label = { net, x: R(x), y: R(y), id: a ? a.getState_PrimitiveId() : null };
			} catch (e) { out.steps.push('labelERR ' + e.message); }
			break;
		}
		case 'gnd': {
			const x = need('x'), y = need('y');
			const c = await eda.sch_PrimitiveComponent.createNetFlag('Ground', 'GND', R(x), R(y), A.rot || 0, false);
			out.gnd = { x: R(x), y: R(y), id: c ? c.getState_PrimitiveId() : null };
			break;
		}
		case 'pwr': {
			const x = need('x'), y = need('y'), net = need('net');
			const c = await eda.sch_PrimitiveComponent.createNetFlag('Power', net, R(x), R(y), A.rot || 0, false);
			out.pwr = { net, x: R(x), y: R(y), id: c ? c.getState_PrimitiveId() : null };
			break;
		}
		case 'frame': {
			const r = await eda.sch_PrimitiveRectangle.create(need('x'), need('y'), need('w'), need('h'), 6, 0, '#7F8FA6', 'none', 2, null, null);
			out.frame = r ? r.getState_PrimitiveId() : null;
			break;
		}
		case 'text': {
			const t = await eda.sch_PrimitiveText.create(need('x'), need('y'), need('content'), 0, A.color || '#2F4858', null, A.size || 15, true, false, false);
			out.text = t ? t.getState_PrimitiveId() : null;
			break;
		}
		case 'snap': {
			const cur = await eda.dmt_SelectControl.getCurrentDocumentInfo();
			const blob = await eda.dmt_EditorControl.getCurrentRenderedAreaImage(cur.tabId);
			const dataUrl = await new Promise((res2, rej) => {
				const fr = new FileReader(); fr.onload = () => res2(fr.result); fr.onerror = () => rej(new Error('read fail')); fr.readAsDataURL(blob);
			});
			out.png = dataUrl; out.size = blob.size;
			break;
		}
		case 'verify': {
			await sleep(600);
			const nl = JSON.parse(await eda.sch_Netlist.getNetlist());
			const nets = {}; const unconn = [];
			for (const id of Object.keys(nl.components || {})) {
				const des = (nl.components[id].props || {}).Designator || id;
				for (const p of Object.keys(nl.components[id].pinInfoMap || {})) {
					const n = nl.components[id].pinInfoMap[p].net || '';
					if (!n) { unconn.push(des + '.' + p); continue; }
					(nets[n] = nets[n] || []).push(des + '.' + p);
				}
			}
			out.nets = Object.keys(nets).sort().map((n) => n + ': ' + nets[n].sort().join(','));
			out.unnamed = Object.keys(nets).filter((n) => n.startsWith('$'));
			out.unconnected = unconn.sort();
			out.expected = A.expect || null;
			if (A.expect) {
				const bad = [];
				for (const net of Object.keys(A.expect)) {
					const want = A.expect[net].slice().sort().join(',');
					const got = (nets[net] || []).slice().sort().join(',');
					if (want !== got) bad.push({ net, want, got });
				}
				out.mismatched = bad;
			}
			break;
		}
		case 'overlaps': {
			// 组件包围盒两两相交检测（够用版）
			const comps = await allComps();
			const boxes = [];
			for (const c of comps) {
				if (!c.des) continue;
				const ps = await pinsOf(c.id);
				if (!ps.length) continue;
				const xs = ps.map((p) => R(p.x)), ys = ps.map((p) => R(p.y));
				boxes.push({ ref: c.des, minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) });
			}
			const hits = [];
			for (let i = 0; i < boxes.length; i++) {
				for (let j = i + 1; j < boxes.length; j++) {
					const a = boxes[i], b = boxes[j];
					const ox = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
					const oy = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
					if (ox > 0 && oy > 0) hits.push({ a: a.ref, b: b.ref, ox, oy });
				}
			}
			out.overlaps = hits;
			out.count = boxes.length;
			break;
		}
		default:
			out.error = 'unknown op: ' + A.op;
	}
} catch (e) {
	out.error = e.message;
}
return out;
