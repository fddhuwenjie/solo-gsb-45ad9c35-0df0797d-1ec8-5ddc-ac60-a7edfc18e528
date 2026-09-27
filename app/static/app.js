/* 古籍修复湿度阶梯试验编排台 —— 原生 JS，无任何框架/依赖 */
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const api = async (url, opts = {}) => {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' }, ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 ${res.status}`);
  return data;
};

const state = {
  samples: [],
  occs: [],
  capacity: 3,
  maxShiftDelta: null,   // 独立换档上限（%RH）；null = 不限制（兼容旧数据）
  result: null,        // 最近一次 schedule/validate 返回
  boardTimes: {},      // 当前泳道使用的入箱分钟（拖拽会改变）
  editingId: null,
  pxPerMin: 2,
  dragging: null,
};

const fmtMin = (m) => {
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), x = m % 60;
  return (d ? d + 'd' : '') + (h ? h + 'h' : '') + ((x || (!d && !h)) ? x + 'm' : '');
};

// --------------------------------------------------------------------------- //
// 数据加载
// --------------------------------------------------------------------------- //
async function loadAll() {
  const [samples, occs, settings] = await Promise.all([
    api('/api/samples'), api('/api/occupancies'), api('/api/settings'),
  ]);
  state.samples = samples;
  state.occs = occs;
  state.capacity = settings.capacity;
  state.maxShiftDelta = settings.max_shift_delta ?? null;
  $('#capacity').value = state.capacity;
  $('#maxShiftDelta').value = state.maxShiftDelta ?? '';
  renderSamples();
  renderOccs();
  const latest = await api('/api/schedule/latest').catch(() => ({}));
  if (latest && latest.segments) {
    state.result = latest;
    state.boardTimes = { ...(latest.board_times || {}) };
    renderTimeline();
    setStatus('已载入上次保存的排程，可直接拖拽调整。', 'ok');
  }
}

// --------------------------------------------------------------------------- //
// 样本卡片 / 弹层
// --------------------------------------------------------------------------- //
function renderSamples() {
  const box = $('#sampleList');
  box.innerHTML = '';
  if (!state.samples.length) {
    box.innerHTML = '<div style="color:#998f7d;font-size:12.5px;margin-top:8px">尚无样本，点击右上角新增。</div>';
    return;
  }
  for (const s of state.samples) {
    const card = document.createElement('div');
    card.className = 'sample-card';
    const steps = s.steps.map((st, i) =>
      `${i + 1}. ${num(st.target)}% × ${st.dwell}m @ ${num(st.rate)}%/m`).join('　');
    const excl = (s.excludes || []).map(id => state.samples.find(x => x.id === id))
      .filter(Boolean).map(x => x.code).join('、');
    card.innerHTML = `
      <div class="sc-head"><span>${esc(s.code)}</span>
        <span style="font-size:11px;color:#998f7d">#${s.id}</span></div>
      <div class="sc-meta">耐受 ${num(s.rh_min)}–${num(s.rh_max)}%RH ｜ 平衡 ${
        num(s.eq_rh)}% ｜ 冷却 ${s.eq_duration}m</div>
      <div class="sc-steps">${esc(steps)}</div>
      ${excl ? `<div class="sc-ex">⛓ 不可相邻：${esc(excl)}</div>` : ''}`;
    card.onclick = () => openSampleModal(s.id);
    box.appendChild(card);
  }
}

function openSampleModal(id = null) {
  state.editingId = id;
  const s = id ? state.samples.find(x => x.id === id) : null;
  $('#modalTitle').textContent = s ? `编辑样本 ${s.code}` : '新样本';
  $('#f_code').value = s?.code || '';
  $('#f_min').value = s?.rh_min ?? '';
  $('#f_max').value = s?.rh_max ?? '';
  $('#f_eq').value = s?.eq_rh ?? '';
  $('#f_eqdur').value = s?.eq_duration ?? 30;
  const sel = $('#f_excl');
  sel.innerHTML = '';
  for (const o of state.samples.filter(x => x.id !== id)) {
    const op = document.createElement('option');
    op.value = o.id; op.textContent = `${o.code} (#${o.id})`;
    if (s?.excludes?.includes(o.id)) op.selected = true;
    sel.appendChild(op);
  }
  renderStepRows(s ? s.steps.map(x => ({ ...x })) :
    [{ target: '', dwell: 30, rate: 2 }]);
  $('#modalDelete').style.display = s ? '' : 'none';
  $('#modalError').textContent = '';
  $('#modal').classList.remove('hidden');
}

function renderStepRows(steps) {
  const body = $('#stepBody');
  body.innerHTML = '';
  steps.forEach((st, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td><input class="s-target" type="number" step="0.1" value="${st.target ?? ''}"></td>
      <td><input class="s-dwell" type="number" step="1" min="0" value="${st.dwell ?? ''}"></td>
      <td><input class="s-rate" type="number" step="0.1" min="0.1" value="${st.rate ?? ''}"></td>
      <td class="del">✕</td>`;
    tr.querySelector('.del').onclick = () => {
      if ($$('#stepBody tr').length > 1) tr.remove(); renumber();
    };
    body.appendChild(tr);
  });
}
function renumber() {
  $$('#stepBody tr').forEach((tr, i) => tr.firstElementChild.textContent = i + 1);
}

async function saveSampleFromModal() {
  const steps = $$('#stepBody tr').map(tr => ({
    target: parseFloat(tr.querySelector('.s-target').value),
    dwell: parseInt(tr.querySelector('.s-dwell').value, 10),
    rate: parseFloat(tr.querySelector('.s-rate').value),
  }));
  const body = {
    id: state.editingId,
    code: $('#f_code').value.trim(),
    rh_min: parseFloat($('#f_min').value),
    rh_max: parseFloat($('#f_max').value),
    eq_rh: $('#f_eq').value === '' ? null : parseFloat($('#f_eq').value),
    eq_duration: parseInt($('#f_eqdur').value, 10),
    steps,
    excludes: $$('#f_excl option:checked').map(o => parseInt(o.value, 10)),
  };
  try {
    await api('/api/samples', { method: 'POST', body });
    $('#modal').classList.add('hidden');
    await loadAll();
  } catch (e) {
    $('#modalError').textContent = e.message;
  }
}

// --------------------------------------------------------------------------- //
// 占用
// --------------------------------------------------------------------------- //
function renderOccs() {
  const box = $('#occList');
  box.innerHTML = '';
  if (!state.occs.length) {
    box.innerHTML = '<div style="color:#998f7d;font-size:12.5px;margin-top:6px">无已有占用。</div>';
    return;
  }
  for (const o of state.occs) {
    const div = document.createElement('div');
    div.className = 'occ-item';
    div.innerHTML = `<span>${fmtMin(o.start)}–${fmtMin(o.end)} ｜ ${num(o.rh)}%RH ｜ ${
      o.slots} 位${o.note ? ' ｜ ' + esc(o.note) : ''}</span><span class="x">✕</span>`;
    div.querySelector('.x').onclick = async () => {
      await api(`/api/occupancies/${o.id}`, { method: 'DELETE' });
      await loadAll();
    };
    box.appendChild(div);
  }
}

function openOccModal() {
  ['o_start', 'o_end', 'o_rh', 'o_note'].forEach(id => $('#' + id).value = '');
  $('#o_slots').value = 1;
  $('#occError').textContent = '';
  $('#occModal').classList.remove('hidden');
}

async function saveOcc() {
  const body = {
    start: parseInt($('#o_start').value, 10),
    end: parseInt($('#o_end').value, 10),
    rh: parseFloat($('#o_rh').value),
    slots: parseInt($('#o_slots').value, 10),
    note: $('#o_note').value.trim(),
  };
  try {
    await api('/api/occupancies', { method: 'POST', body });
    $('#occModal').classList.add('hidden');
    await loadAll();
  } catch (e) {
    $('#occError').textContent = e.message;
  }
}

// --------------------------------------------------------------------------- //
// 排程
// --------------------------------------------------------------------------- //
async function runSchedule() {
  setStatus('正在求解可执行顺序…', 'warn');
  try {
    state.result = await api('/api/schedule', {
      method: 'POST',
      body: { capacity: state.capacity,
              max_shift_delta: state.maxShiftDelta },
    });
    state.boardTimes = { ...(state.result.board_times || {}) };
    renderTimeline();
    if (state.result.feasible) {
      setStatus(`✓ 排程可行：${state.result.lanes.length} 个样本任务，总时长 ${
        fmtMin(state.result.end_minute)}。可直接拖拽泳道调整入箱时刻。`, 'ok');
    } else {
      setStatus('✗ 约束无解，请查看下方冲突与最小调整建议。', 'bad');
    }
  } catch (e) {
    setStatus('求解失败：' + e.message, 'bad');
  }
}

async function revalidate() {
  try {
    state.result = await api('/api/validate', {
      method: 'POST',
      body: { capacity: state.capacity,
              max_shift_delta: state.maxShiftDelta,
              board_times: state.boardTimes },
    });
    renderTimeline();
    if (state.result.feasible) {
      setStatus('✓ 拖拽后的手工排程通过全部约束校验' +
        '（容量 / 耐受区间 / 速率 / 独立换档上限 / 不可相邻）。', 'ok');
    } else {
      const n = state.result.violations.length;
      const nShift = state.result.violations.filter(v =>
        v.kind === 'shift-limit').length;
      setStatus(`✗ 当前手工排程存在 ${n} 处违规${nShift ?
        `（其中 ${nShift} 处独立换档上限超限，见下方调整建议）` : ''}，` +
        '时间轴上以红色标记。可继续拖动或重置。', 'bad');
    }
  } catch (e) {
    setStatus('校验失败：' + e.message, 'bad');
  }
}

// --------------------------------------------------------------------------- //
// 时间轴渲染
// --------------------------------------------------------------------------- //
function timelineMinutes() {
  const r = state.result;
  if (!r) return 60;
  let max = r.end_minute || 0;
  for (const o of state.occs) max = Math.max(max, o.end);
  for (const l of r.lanes || []) max = Math.max(max, l.unboard || l.board + 30);
  return Math.max(60, max + 20);
}

function renderTimeline() {
  const r = state.result;
  const conflictBox = $('#conflictBox');
  conflictBox.classList.add('hidden');
  conflictBox.innerHTML = '';
  $('#detail').classList.add('hidden');
  if (!r) return;

  if (!r.feasible && r.conflicts?.length) renderConflicts(r.conflicts);
  const shiftViolations = (r.violations || []).filter(v => v.kind === 'shift-limit');
  if (!r.feasible && shiftViolations.length) renderShiftViolations(shiftViolations);

  const total = timelineMinutes();
  state.pxPerMin = total > 1000 ? 0.8 : total > 500 ? 1.2 : 2;
  const W = Math.max(900, total * state.pxPerMin + 120);

  renderRuler(W, total);
  renderRhTrack(W, total, r);
  renderLanes(W, r);
  renderOccTrack(W, total);
  renderCapTrack(W, r);
  renderViolations(W, r);
}

function renderRuler(W, total) {
  const ruler = $('#ruler');
  ruler.style.width = W + 'px';
  ruler.innerHTML = '<span class="track-label" style="background:transparent">时间 →</span>';
  const step = total > 1000 ? 120 : total > 500 ? 60 : 30;
  for (let m = 0; m <= total; m += step) {
    const t = document.createElement('div');
    t.className = 'tick';
    t.style.left = (74 + m * state.pxPerMin) + 'px';
    t.textContent = fmtMin(m);
    ruler.appendChild(t);
  }
}

function renderRhTrack(W, total, r) {
  const track = $('#rhTrack');
  track.style.width = W + 'px';
  track.innerHTML = '<span class="track-label">箱内湿度</span>';
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('x', 74); svg.setAttribute('y', 0);
  svg.setAttribute('width', W - 74); svg.setAttribute('height', 64);
  svg.style.left = '74px';
  const L = 26, R = 8;
  const yOf = rh => {
    const lo = 0, hi = 100;
    return L + (1 - (rh - lo) / (hi - lo)) * (64 - L - R);
  };
  const xOf = m => m * state.pxPerMin;

  // 0/50/100 参考线
  for (const v of [0, 50, 100]) {
    const line = document.createElementNS(svgNS, 'line');
    line.setAttribute('x1', 0); line.setAttribute('x2', W - 80);
    line.setAttribute('y1', yOf(v)); line.setAttribute('y2', yOf(v));
    line.setAttribute('stroke', v === 50 ? '#e2dac8' : '#f0ecdf');
    svg.appendChild(line);
    const lab = document.createElementNS(svgNS, 'text');
    lab.setAttribute('x', 2); lab.setAttribute('y', yOf(v) - 2);
    lab.setAttribute('font-size', 9); lab.setAttribute('fill', '#a89f8c');
    lab.textContent = v;
    svg.appendChild(lab);
  }
  for (const seg of r.segments || []) {
    if (seg.kind === 'hold') {
      const line = document.createElementNS(svgNS, 'line');
      line.setAttribute('x1', xOf(seg.start));
      line.setAttribute('x2', xOf(seg.end));
      line.setAttribute('y1', yOf(seg.start_rh));
      line.setAttribute('y2', yOf(seg.end_rh));
      line.setAttribute('stroke', '#5e8b6e');
      line.setAttribute('stroke-width', 2);
      line.classList.add('seg-hit');
      line.dataset.start = seg.start;
      svg.appendChild(line);
    } else {
      const x1 = xOf(seg.start), x2 = xOf(seg.end);
      const line = document.createElementNS(svgNS, 'line');
      line.setAttribute('x1', x1); line.setAttribute('x2', x2);
      line.setAttribute('y1', yOf(seg.from_rh ?? seg.start_rh));
      line.setAttribute('y2', yOf(seg.end_rh));
      line.setAttribute('stroke', '#c76a3e');
      line.setAttribute('stroke-width', 2);
      svg.appendChild(line);
    }
    // 段可点击查看来源
    const hit = document.createElementNS(svgNS, 'rect');
    hit.setAttribute('x', xOf(seg.start));
    hit.setAttribute('x', xOf(seg.start));
    hit.setAttribute('y', 0);
    hit.setAttribute('width', Math.max(3, xOf(seg.end) - xOf(seg.start)));
    hit.setAttribute('height', 64);
    hit.setAttribute('fill', 'transparent');
    hit.style.cursor = 'pointer';
    hit.onclick = () => showSegmentDetail(seg);
    svg.appendChild(hit);
  }
  track.appendChild(svg);
}

function renderLanes(W, r) {
  const box = $('#lanes');
  box.innerHTML = '';
  const byId = Object.fromEntries(state.samples.map(s => [s.id, s]));
  for (const lane of r.lanes || []) {
    const row = document.createElement('div');
    row.className = 'lane movable';
    row.style.width = W + 'px';
    row.dataset.sampleId = lane.sample_id;
    const name = document.createElement('span');
    name.className = 'lane-name';
    name.textContent = lane.code;
    name.title = `${lane.code}：耐受 ${num(lane.rh_min)}-${num(lane.rh_max)}%，` +
      `入箱平衡 ${num(lane.eq_rh)}%（拖动右侧空白区域可整体平移入箱时刻）`;
    row.appendChild(name);

    // 整条在箱期背景（拖拽手柄）
    const handle = document.createElement('div');
    handle.className = 'block board';
    handle.style.opacity = '0.0';
    handle.style.left = (74 + lane.board * state.pxPerMin) + 'px';
    handle.style.width = Math.max(8, ((lane.unboard ?? lane.board + 5) - lane.board) *
      state.pxPerMin) + 'px';
    handle.dataset.drag = '1';
    row.appendChild(handle);

    for (const p of lane.pieces) {
      const b = document.createElement('div');
      b.className = 'block ' + p.kind;
      const w = Math.max(3, (p.end - p.start) * state.pxPerMin);
      b.style.left = (74 + p.start * state.pxPerMin) + 'px';
      b.style.width = w + 'px';
      const label = phaseLabel(p, lane);
      b.textContent = label;
      b.title = `${lane.code} · ${phaseName(p.kind)}${
        p.step >= 0 ? ' 第' + (p.step + 1) + '档' : ''}：${
        fmtMin(p.start)}–${fmtMin(p.end)}`;
      b.dataset.viol = '';
      row.appendChild(b);
    }
    box.appendChild(row);
  }
  bindDrag();
}

function phaseName(k) {
  return { ramp: '换档', hold: '保持', cooldown: '冷却保持',
    'cooldown-ramp': '冷却换档', board: '入箱平衡', wait: '等待/偏离' }[k] || k;
}
function phaseLabel(p, lane) {
  if (p.kind === 'hold' && p.step >= 0) {
    const st = byStep(lane.sample_id, p.step);
    return `第${p.step + 1}档 ${num(st?.target)}% 保持`;
  }
  if (p.kind === 'ramp') {
    return p.step >= 0 ? `→第${p.step + 1}档换档` : '换档';
  }
  if (p.kind.startsWith('cooldown')) return '冷却/平衡';
  if (p.kind === 'board') return '入箱';
  return '';
}
function byStep(sid, i) {
  return state.samples.find(s => s.id === sid)?.steps?.[i];
}

function renderOccTrack(W, total) {
  const track = $('#occTrack');
  track.style.width = W + 'px';
  track.innerHTML = '<span class="track-label">已有占用</span>';
  for (const o of state.occs) {
    const b = document.createElement('div');
    b.className = 'occ-block';
    b.style.left = (74 + o.start * state.pxPerMin) + 'px';
    b.style.width = Math.max(4, (o.end - o.start) * state.pxPerMin) + 'px';
    b.textContent = `🔒 ${o.note || '占用'} ${num(o.rh)}% ×${o.slots}位`;
    b.title = `占用 ${fmtMin(o.start)}-${fmtMin(o.end)}，固定 ${num(o.rh)}%RH，${o.slots} 位`;
    track.appendChild(b);
  }
}

function renderCapTrack(W, r) {
  const track = $('#capTrack');
  track.style.width = W + 'px';
  track.innerHTML = '<span class="track-label">容量占用</span>';
  for (const c of r.capacity_series || []) {
    const ratio = c.load / state.capacity;
    const d = document.createElement('div');
    d.className = 'cap-cell';
    d.style.left = (74 + c.start * state.pxPerMin) + 'px';
    d.style.width = Math.max(3, (c.end - c.start) * state.pxPerMin) + 'px';
    d.style.background = c.load > state.capacity ? 'var(--bad)' :
      ratio > 0.8 ? '#d19a52' : ratio > 0 ? '#7fa083' : '#e8e2d2';
    d.style.color = ratio > 0 ? '#fff' : '#b7af9d';
    d.textContent = c.load;
    d.title = `${fmtMin(c.start)}-${fmtMin(c.end)}：占用 ${c.load}/${state.capacity}`;
    track.appendChild(d);
  }
}

function renderViolations(W, r) {
  const mins = {};
  for (const v of r.violations || []) {
    (mins[v.minute] = mins[v.minute] || []).push(v);
    // 泳道块标红
    for (const row of $$('#lanes .lane')) {
      const sid = parseInt(row.dataset.sampleId, 10);
      if (v.samples && !v.samples.includes(sid)) continue;
      for (const b of $$('.block', row)) {
        const st = parseFloat(b.style.left) - 74;
        const en = st + parseFloat(b.style.width);
        if (v.minute * state.pxPerMin >= st - 1 &&
            v.minute * state.pxPerMin < en + 1) {
          b.classList.add('viol');
          b.title += `\n⛔ ${v.message}`;
        }
      }
    }
  }
  // 每条泳道顶层放红色标记线（画在 lanes 容器上）
  const box = $('#lanes');
  for (const [m, vs] of Object.entries(mins)) {
    const flag = document.createElement('div');
    flag.className = 'viol-flag';
    flag.style.left = (74 + m * state.pxPerMin) + 'px';
    flag.style.top = '0';
    flag.textContent = '⛔';
    flag.title = vs.map(x => x.message).join('\n');
    box.appendChild(flag);
  }
}

// --------------------------------------------------------------------------- //
// 段来源详情
// --------------------------------------------------------------------------- //
function showSegmentDetail(seg) {
  const d = $('#detail');
  d.classList.remove('hidden');
  const sources = (seg.sources || []).map(s => {
    if (s.type === 'occupancy') return `<div class="src-line">🔒 约束来源：<b>${esc(s.label)}</b></div>`;
    return `<div class="src-line">📄 约束来源：样本 <b>${esc(s.code)}</b> 第 ${s.step} 档（${s.phase}）</div>`;
  }).join('') || '<div class="src-line">（空载/过渡段，无样本约束）</div>';
  d.innerHTML = `
    <h4>${seg.kind === 'ramp' ? '换档段' : '保持段'} ${fmtMin(seg.start)}–${
      fmtMin(seg.end)} ｜ 湿度 ${num(seg.from_rh ?? seg.start_rh)}% → ${num(seg.end_rh)}%
      ｜ 在箱：${(seg.aboard || []).map(esc).join('、') || '（空箱）'}</h4>
    ${sources}`;
}

// --------------------------------------------------------------------------- //
// 冲突面板
// --------------------------------------------------------------------------- //
function renderConflicts(conflicts) {
  const box = $('#conflictBox');
  box.classList.remove('hidden');
  box.innerHTML = '<h4>冲突约束与最小可调整项</h4>';
  conflicts.forEach((c, i) => {
    const div = document.createElement('div');
    div.className = 'conflict';
    const tag = `<span class="tag ${c.severity === 'soft' ? 'soft' : ''}">${
      { capacity: '容量', range: '区间', rate: '换档速率',
        'shift-limit': '换档上限', adjacency: '不可相邻',
        occupancy: '已有占用', 'occupancy-window': '占用时间窗',
        horizon: '总机时', combination: '组合约束', 'occ-overlap': '占用重叠'
      }[c.kind] || c.kind}</span>`;
    let fix = '';
    if (c.suggestion) {
      fix = `<div class="fixit"><button data-i="${i}">⚙ 应用最小调整：${esc(c.suggestion.title)}</button></div>`;
    }
    div.innerHTML = `${tag}<span class="msg">${esc(c.message)}</span>${fix}`;
    box.appendChild(div);
  });
  $$('.fixit button', box).forEach(btn => {
    btn.onclick = () => applyFix(conflicts[+btn.dataset.i].suggestion);
  });
}

// 拖拽重校验中"独立换档上限"违规：指出相邻段、差值与可调整项
function renderShiftViolations(violations) {
  const box = $('#conflictBox');
  box.classList.remove('hidden');
  if (!box.innerHTML.trim()) box.innerHTML = '<h4>冲突约束与最小可调整项</h4>';
  violations.forEach((v, i) => {
    const segTxt = (v.adjacent_segments || []).length === 2
      ? `相邻段：${fmtMin(v.adjacent_segments[0].start)}–${
          fmtMin(v.adjacent_segments[0].end)}（${num(v.from_rh)}%）→ ${
          fmtMin(v.adjacent_segments[1].start)}–${
          fmtMin(v.adjacent_segments[1].end)}（${num(v.to_rh)}%）；`
      : `${fmtMin(v.minute)} 起换档 ${num(v.from_rh)}% → ${num(v.to_rh)}%；`;
    const div = document.createElement('div');
    div.className = 'conflict';
    const first = (v.adjustments || [])[0];
    const others = (v.adjustments || []).slice(1)
      .map(a => `<span class="mlink">· ${esc(a.label)}</span>`).join('<br>');
    div.innerHTML =
      `<span class="tag">换档上限</span>` +
      `<span class="msg">独立换档上限 ${num(v.limit)}%RH 被突破：${segTxt}` +
      `差值 <b>${num(v.delta)}%RH</b> 超限。</span>` +
      (first ? `<div class="fixit"><button data-i="${i}">⚙ 应用调整：${
        esc(first.label)}</button></div>` : '') +
      (others ? `<div class="alt-fix">其他可调整项：<br>${others}</div>` : '');
    box.appendChild(div);
    const btn = div.querySelector('.fixit button');
    if (btn) {
      btn.onclick = () => applyFix(first);
    }
  });
}

async function applyFix(sug) {
  try {
    if (sug.type === 'shift-limit') {
      // 放宽独立换档上限：保存设置；若当前有排程则立刻用同一拖拽结果重校验
      state.maxShiftDelta = sug.value;
      $('#maxShiftDelta').value = sug.value;
      await api('/api/settings', {
        method: 'POST',
        body: { max_shift_delta: sug.value },
      });
      if (state.result && (state.result.lanes || []).length) {
        await revalidate();
      }
      setStatus(`已把独立换档上限放宽为 ${sug.value}%RH，可直接拖拽或重新生成排程。`,
        'ok');
    } else if (sug.type === 'capacity') {
      state.capacity = Math.max(state.capacity, sug.value || state.capacity + 1);
      $('#capacity').value = state.capacity;
      await api('/api/settings', { method: 'POST', body: { capacity: state.capacity } });
      setStatus(`已把箱容量调整为 ${state.capacity}，请重新生成排程。`, 'ok');
    } else if (sug.type === 'adjacency' && sug.samples) {
      const [a, b] = sug.samples;
      const sa = state.samples.find(s => s.id === a);
      const sb = state.samples.find(s => s.id === b);
      if (sa && sb) {
        const ex = new Set([...(sa.excludes || []), b]);
        await api('/api/samples', {
          method: 'POST',
          body: { ...sa, excludes: [...ex] },
        });
        await loadAll();
        setStatus(`已把 ${sa.code} 与 ${sb.code} 标记为不可相邻，请重新生成排程。`, 'ok');
      }
    } else if (sug.type === 'rate' && sug.sample_id) {
      const s = state.samples.find(x => x.id === sug.sample_id);
      if (s) {
        const steps = s.steps.map((st, j) => j === sug.step - 1 ?
          { ...st, rate: Math.max(st.rate, sug.value) } : st);
        await api('/api/samples', { method: 'POST', body: { ...s, steps } });
        await loadAll();
        setStatus(`已放宽 ${s.code} 第 ${sug.step} 档速率，请重新生成排程。`, 'ok');
      }
    } else {
      setStatus('该建议需要手工调整已有占用段的时间或湿度，请在左侧修改后重新排程。', 'warn');
      return;
    }
  } catch (e) {
    setStatus('应用调整失败：' + e.message, 'bad');
  }
}

// --------------------------------------------------------------------------- //
// 拖拽
// --------------------------------------------------------------------------- //
function bindDrag() {
  $$('#lanes .lane').forEach(row => {
    const sid = parseInt(row.dataset.sampleId, 10);
    row.addEventListener('pointerdown', (e) => {
      if (!e.target.dataset.drag) return;
      if (!state.result?.feasible && state.result?.fatal === 'NO_FEASIBLE_SCHEDULE') {
        setStatus('无解排程无法拖拽；请先应用调整建议或修改输入后重新生成。', 'warn');
        return;
      }
      e.preventDefault();
      const startX = e.clientX;
      const orig = state.boardTimes[sid] ?? 0;
      const blocks = $$('.block', row);
      const init = blocks.map(b => parseFloat(b.style.left));
      document.body.style.cursor = 'grabbing';

      const move = (ev) => {
        const dm = Math.round((ev.clientX - startX) / state.pxPerMin);
        const nt = Math.max(0, orig + dm);
        state.boardTimes[sid] = nt;
        blocks.forEach((b, i) => {
          b.style.left = (init[i] + dm * state.pxPerMin) + 'px';
        });
      };
      const up = async () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        document.body.style.cursor = '';
        await revalidate();
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
    });
  });
}

// --------------------------------------------------------------------------- //
// 导出
// --------------------------------------------------------------------------- //
function exportJSON() {
  if (!state.result) {
    alert('请先生成排程');
    return;
  }
  const payload = {
    exported_at: new Date().toISOString(),
    feasible: state.result.feasible,
    capacity: state.capacity,
    max_shift_delta: state.result.max_shift_delta ?? state.maxShiftDelta,
    board_times: state.boardTimes,
    end_minute: state.result.end_minute,
    end_display: fmtMin(state.result.end_minute),
    samples: state.result.samples || state.samples,
    occupancies: state.occs,
    chamber_segments: (state.result.segments || []).map(s => ({
      start_minute: s.start, end_minute: s.end,
      start: fmtMin(s.start), end: fmtMin(s.end),
      type: s.kind,
      rh_start: s.from_rh ?? s.start_rh, rh_end: s.end_rh,
      aboard: s.aboard, constraints: s.sources,
    })),
    sample_lanes: (state.result.lanes || []).map(l => ({
      sample_id: l.sample_id, code: l.code,
      board_minute: l.board, unboard_minute: l.unboard,
      board: fmtMin(l.board),
      unboard: l.unboard == null ? null : fmtMin(l.unboard),
      pieces: l.pieces.map(p => ({
        start_minute: p.start, end_minute: p.end,
        start: fmtMin(p.start), end: fmtMin(p.end),
        phase: phaseName(p.kind), step: p.step >= 0 ? p.step + 1 : null,
      })),
    })),
    violations: state.result.violations || [],
    conflicts: state.result.conflicts || [],
    minimal_adjustment: state.result.minimal_adjustment || null,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)],
    { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `humidity-schedule-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// --------------------------------------------------------------------------- //
function setStatus(msg, kind = '') {
  const el = $('#statusBar');
  el.textContent = msg;
  el.className = 'status ' + kind;
}
const num = (v) => (v == null || isNaN(v)) ? '' :
  (String(v).includes('.') ? String(parseFloat(v.toFixed(2))) : String(v));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// --------------------------------------------------------------------------- //
// 事件绑定
// --------------------------------------------------------------------------- //
$('#addSampleBtn').onclick = () => openSampleModal();
$('#modalCancel').onclick = () => $('#modal').classList.add('hidden');
$('#modalSave').onclick = saveSampleFromModal;
$('#modalDelete').onclick = async () => {
  if (state.editingId && confirm('确定删除该样本及其全部阶梯？')) {
    await api(`/api/samples/${state.editingId}`, { method: 'DELETE' });
    $('#modal').classList.add('hidden');
    await loadAll();
  }
};
$('#addStepBtn').onclick = () => {
  const body = $('#stepBody');
  renderStepRows([...$$('#stepBody tr').map((tr, i) => ({
    target: parseFloat(tr.querySelector('.s-target').value),
    dwell: parseInt(tr.querySelector('.s-dwell').value, 10),
    rate: parseFloat(tr.querySelector('.s-rate').value),
  })), { target: '', dwell: 30, rate: 2 }]);
};
$('#addOccBtn').onclick = openOccModal;
$('#occCancel').onclick = () => $('#occModal').classList.add('hidden');
$('#occSave').onclick = saveOcc;
$('#saveCapBtn').onclick = async () => {
  const cap = parseInt($('#capacity').value, 10);
  if (!(cap >= 1)) return setStatus('容量必须 ≥1', 'bad');
  const raw = $('#maxShiftDelta').value.trim();
  let shift = null;
  if (raw !== '') {
    shift = parseFloat(raw);
    if (!(shift > 0) || shift > 100) {
      return setStatus('独立换档上限必须是 0.1–100 之间的正数（留空表示不限制）',
        'bad');
    }
  }
  try {
    const saved = await api('/api/settings', {
      method: 'POST',
      body: { capacity: cap, max_shift_delta: shift },
    });
    state.capacity = saved.capacity;
    state.maxShiftDelta = saved.max_shift_delta ?? null;
    $('#capacity').value = state.capacity;
    $('#maxShiftDelta').value = state.maxShiftDelta ?? '';
    setStatus(`设置已保存：容量 ${cap}；独立换档上限 ${
      state.maxShiftDelta == null ? '不限制' : state.maxShiftDelta + '%RH'}。`, 'ok');
  } catch (e) {
    setStatus('设置保存失败：' + e.message, 'bad');
  }
};
$('#runBtn').onclick = runSchedule;
$('#resetDragBtn').onclick = () => {
  if (state.result?.board_times) {
    state.boardTimes = { ...state.result.board_times };
    revalidate();
  }
};
$('#exportBtn').onclick = exportJSON;

loadAll().catch(e => setStatus('初始化失败：' + e.message, 'bad'));
