(function(){
'use strict';

/* ---------------- constants ---------------- */
var C = {
  s1:'#3987e5', s2:'#199e70', s3:'#c98500', s4:'#008300', accent:'#818cf8',
  muted:'#646b7c', grid:'#1c202c', surface2:'#1a1e2a',
  text:'#e8eaf0', text2:'#9ba1b0', border:'rgba(255,255,255,0.07)'
};
var KV_POOL = 930000;
var MAX_PTS = 400;
var CTR_NAMES = ['vllm-ds4-head', 'vllm-ds4-worker'];
var NODE_KEYS = ['spark-9e60', 'spark-0c6b'];
var TH = { temp:[70,80], mem:[90,95], kv:[70,90] };
var fmtHM = new Intl.DateTimeFormat([], { hour:'2-digit', minute:'2-digit' });

/* ---------------- refs (cached once) ---------------- */
function $(id){ return document.getElementById(id); }
function nodeRefs(i){
  var p = 'n' + i + '-';
  return {
    card: $('node-' + i), dot: $(p+'dot'), name: $(p+'name'), badge: $(p+'badge'),
    off: $(p+'off'), sub: $(p+'sub'),
    temp: $(p+'temp'), tempDot: $(p+'tempdot'), power: $(p+'power'),
    util: $(p+'util'), clock: $(p+'clock'),
    memTxt: $(p+'memtxt'), memDot: $(p+'memdot'), memFill: $(p+'memfill'),
    cpuTxt: $(p+'cputxt'), cpuFill: $(p+'cpufill'),
    ctr: $(p+'ctr'), ctrTxt: $(p+'ctrtxt')
  };
}
var refs = {
  model: $('hdr-model'), ctx: $('hdr-ctx'),
  pill: $('pill'), pillTxt: $('pill-txt'), clock: $('clock'),
  engChip: $('eng-chip'),
  gVal: $('g-val'), pVal: $('p-val'),
  rVal: $('r-val'), rWait: $('r-wait'), rSat: $('r-sat'),
  tVal: $('t-val'), dVal: $('d-val'), dSub: $('d-sub'),
  kvFill: $('kv-fill'), kvPct: $('kv-pct'), kvTok: $('kv-tok'), kvDot: $('kv-dot'),
  sdAccept: $('sd-accept'), sdMean: $('sd-mean'), sdPrefix: $('sd-prefix'),
  ppF: [$('pp0f'), $('pp1f'), $('pp2f')],
  ppV: [$('pp0v'), $('pp1v'), $('pp2v')],
  node: [nodeRefs(0), nodeRefs(1)]
};

/* ---------------- DOM write helpers (change-detecting) ---------------- */
function setText(el, s){ if (el.__t !== s) { el.__t = s; el.textContent = s; } }
function setMeter(el, pct){
  var v = pct == null ? 0 : pct;
  if (v < 0) v = 0;
  if (v > 100) v = 100;
  var s = 'scaleX(' + (v / 100).toFixed(4) + ')';
  if (el.__m !== s) { el.__m = s; el.style.transform = s; }
}
function setDot(el, state){ /* state: 'ok'|'warn'|'crit'|null */
  if (el.__s !== state) { el.__s = state; el.className = 'sdot' + (state ? ' ' + state : ''); }
}
function setChip(el, state){ /* keeps base 'chip' class, swaps state class */
  if (el.__s !== state) { el.__s = state; el.className = 'chip' + (state ? ' ' + state : ''); }
}
function setHidden(el, hide){ if (el.__h !== hide) { el.__h = hide; el.classList.toggle('hidden', hide); } }
function lvl(v, wc){ return v == null ? null : v >= wc[1] ? 'crit' : v >= wc[0] ? 'warn' : 'ok'; }

/* ---------------- number formatting ---------------- */
function f0(v){ return v == null ? '—' : String(Math.round(v)); }
function f1(v){ return v == null ? '—' : Number(v).toFixed(1); }
function f2(v){ return v == null ? '—' : Number(v).toFixed(2); }
function fmtK(v){ return Math.round(v / 1000) + 'K'; }
function pct0(v){ return v == null ? '—' : Math.round(v) + '%'; }

/* ---------------- sparkline module (not Chart.js) ---------------- */
function makeSpark(canvas){
  var N = 64, buf = new Float64Array(N);
  var head = 0, count = 0, w = 0, h = 0;
  var ctx = canvas.getContext('2d');
  function resize(){
    var dpr = window.devicePixelRatio || 1;
    var r = canvas.getBoundingClientRect();
    w = r.width || 1; h = r.height || 1;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function push(v){
    if (v == null || !isFinite(v)) return;
    buf[head] = v; head = (head + 1) % N;
    if (count < N) count++;
  }
  function reset(){ head = 0; count = 0; }
  function paint(){
    ctx.clearRect(0, 0, w, h);
    if (count < 2) return;
    var i, v, mn = Infinity, mx = -Infinity;
    for (i = 0; i < count; i++) {
      v = buf[(head - count + i + N) % N];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    if (mx - mn < 1e-9) { mx += 1; mn -= 1; }
    var pad = 3, sx = (w - 2 * pad) / (count - 1), sy = (h - 2 * pad) / (mx - mn);
    var lx = 0, ly = 0;
    ctx.beginPath();
    for (i = 0; i < count; i++) {
      v = buf[(head - count + i + N) % N];
      lx = pad + i * sx; ly = h - pad - (v - mn) * sy;
      if (i) ctx.lineTo(lx, ly); else ctx.moveTo(lx, ly);
    }
    ctx.strokeStyle = C.muted; ctx.lineWidth = 1.5; ctx.lineJoin = 'round'; ctx.stroke();
    ctx.beginPath();
    ctx.arc(lx, ly, 2.5, 0, 6.2832);
    ctx.fillStyle = C.accent; ctx.fill();
  }
  resize();
  return { push: push, paint: paint, reset: reset, resize: resize };
}
var SP = {
  gen: makeSpark($('sp-gen')),
  prompt: makeSpark($('sp-prompt')),
  run: makeSpark($('sp-run')),
  ttft: makeSpark($('sp-ttft')),
  cpu: [makeSpark($('sp-cpu0')), makeSpark($('sp-cpu1'))]
};
var ALL_SPARKS = [SP.gen, SP.prompt, SP.run, SP.ttft, SP.cpu[0], SP.cpu[1]];
function paintSparks(){ for (var i = 0; i < ALL_SPARKS.length; i++) ALL_SPARKS[i].paint(); }

/* ---------------- charts ---------------- */
Chart.defaults.font.family = 'Inter,system-ui,sans-serif';
Chart.defaults.color = C.muted;

/* acceptance band plugin: --surface-2 rect between y 35 and 70, before datasets */
var bandPlugin = {
  id: 'band',
  beforeDatasetsDraw: function(chart, args, opts){
    var y = chart.scales.y, a = chart.chartArea;
    if (!y || !a || opts.lo == null) return;
    var top = y.getPixelForValue(opts.hi), bot = y.getPixelForValue(opts.lo);
    chart.ctx.save();
    chart.ctx.fillStyle = C.surface2;
    chart.ctx.fillRect(a.left, top, a.right - a.left, bot - top);
    chart.ctx.restore();
  }
};

function lineDs(label, color, extra){
  var ds = { label: label, data: [], borderColor: color, backgroundColor: 'transparent', fill: false };
  if (extra) for (var k in extra) ds[k] = extra[k];
  return ds;
}
function tipLabel(item){
  var y = item.parsed.y;
  return ' ' + item.dataset.label + ': ' + (y == null ? '—' : String(Math.round(y * 10) / 10));
}
function makeChart(canvas, datasets, yExtra, inlinePlugins, pluginOpts){
  var yTicks = { maxTicksLimit: 4, color: C.muted, font: { size: 10 } };
  var y = { grid: { color: C.grid, drawTicks: false }, border: { display: false }, ticks: yTicks };
  if (yExtra) {
    for (var k in yExtra) {
      if (k === 'ticks') { for (var tk in yExtra.ticks) yTicks[tk] = yExtra.ticks[tk]; }
      else y[k] = yExtra[k];
    }
  }
  var plugins = {
    legend: { display: false },
    /* threshold > MAX_PTS: min-max decimation coerces null gap points to 0,
       which can bridge engine-down gaps; keep it unreachable */
    decimation: { enabled: true, algorithm: 'min-max', samples: 250, threshold: 500 },
    tooltip: {
      animation: false,
      backgroundColor: C.surface2,
      borderColor: C.border,
      borderWidth: 1,
      titleColor: C.text2,
      bodyColor: C.text,
      padding: 10,
      cornerRadius: 8,
      boxPadding: 4,
      callbacks: {
        title: function(items){ return items.length ? fmtHM.format(items[0].parsed.x) : ''; },
        label: tipLabel
      }
    }
  };
  if (pluginOpts) for (var pk in pluginOpts) plugins[pk] = pluginOpts[pk];
  return new Chart(canvas, {
    type: 'line',
    data: { datasets: datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      normalized: true,
      parsing: false,
      spanGaps: false,
      interaction: { mode: 'index', intersect: false },
      elements: {
        point: { radius: 0, hoverRadius: 4, hitRadius: 10 },
        line: { borderWidth: 2, tension: 0 }
      },
      scales: {
        x: {
          type: 'linear', bounds: 'data',
          grid: { display: false }, border: { display: false },
          ticks: {
            maxTicksLimit: 5, maxRotation: 0, autoSkip: true,
            color: '#646b7c', font: { size: 10 },
            callback: function(v){ return fmtHM.format(v); }
          }
        },
        y: y
      },
      plugins: plugins
    },
    plugins: inlinePlugins || []
  });
}

var chGen = makeChart($('c-gen'), [
  lineDs('generation', C.s1)
], { min: 0 });

var chCache = makeChart($('c-cache'), [
  lineDs('prefill (cache hit)', C.s2)
], { min: 0 });

var chCompute = makeChart($('c-compute'), [
  lineDs('prefill (compute)', C.s4)
], { min: 0 });

var chReq = makeChart($('c-req'), [
  lineDs('running', C.s1, { stepped: true, fill: 'origin', backgroundColor: 'rgba(57,135,229,0.10)' }),
  lineDs('waiting', C.s3, { stepped: true })
], { min: 0, suggestedMax: 12, ticks: { precision: 0 } });

var chKv = makeChart($('c-kv'), [
  lineDs('kv used', C.accent, { fill: 'origin', backgroundColor: 'rgba(129,140,248,0.10)' })
], { min: 0, max: 100 });

var chAcc = makeChart($('c-acc'), [
  lineDs('acceptance', C.s1)
], { min: 0, max: 100 }, [bandPlugin], { band: { lo: 35, hi: 70 } });

var chTemp = makeChart($('c-temp'), [
  lineDs('head', C.s1),
  lineDs('worker', C.s2)
], { min: 40, max: 90 });

var chPow = makeChart($('c-pow'), [
  lineDs('head', C.s1),
  lineDs('worker', C.s2)
], { min: 0, max: 100 });

var charts = [chGen, chCache, chCompute, chReq, chKv, chAcc, chTemp, chPow];
function updateCharts(){ for (var i = 0; i < charts.length; i++) charts[i].update('none'); }

/* dataset data array refs (mutated in place, never reassigned) */
var DS = {
  gen: chGen.data.datasets[0].data,
  cacheHit: chCache.data.datasets[0].data,
  compute: chCompute.data.datasets[0].data,
  running: chReq.data.datasets[0].data,
  waiting: chReq.data.datasets[1].data,
  kv: chKv.data.datasets[0].data,
  accept: chAcc.data.datasets[0].data,
  temp: [chTemp.data.datasets[0].data, chTemp.data.datasets[1].data],
  power: [chPow.data.datasets[0].data, chPow.data.datasets[1].data]
};
function pushPt(arr, x, y){
  arr.push({ x: x, y: y == null ? null : y });
  if (arr.length > MAX_PTS) arr.splice(0, arr.length - MAX_PTS);
}

/* ---------------- connection state ---------------- */
var connState = '';
var lastSnapshotAt = 0;
var latestSnap = null;
var lastPushedT = 0;
var rafId = 0;
var dirty = false;

function setConn(state, secs){
  var txt = state === 'live' ? 'LIVE'
          : state === 'stale' ? 'STALE ' + secs + 's'
          : state === 'reconnecting' ? 'RECONNECTING'
          : 'CONNECTING';
  setText(refs.pillTxt, txt);
  if (connState !== state) {
    connState = state;
    refs.pill.classList.toggle('live', state === 'live');
    document.body.classList.toggle('stale', state === 'stale');
    document.body.classList.toggle('reconnecting', state === 'reconnecting');
  }
}

/* ---------------- DOM apply (runs inside rAF) ---------------- */
function dashKpis(){
  setText(refs.gVal, '—'); setText(refs.pVal, '—'); setText(refs.rVal, '—');
  setText(refs.rWait, '— wait'); setChip(refs.rWait, null);
  setHidden(refs.rSat, true);
  setText(refs.tVal, '—'); setText(refs.dVal, '—'); setText(refs.dSub, '(— ms)');
  setText(refs.kvPct, '—'); setText(refs.kvTok, '— / 930K tok');
  setMeter(refs.kvFill, 0); setDot(refs.kvDot, null);
  setText(refs.sdAccept, '—'); setText(refs.sdMean, '—');
  for (var i = 0; i < 3; i++) { setMeter(refs.ppF[i], 0); setText(refs.ppV[i], '—'); }
  setText(refs.sdPrefix, 'prefix cache — (1m) · — (life)');
}

function applyDom(d){
  var v = d.vllm, vup = !!(v && v.up);
  setHidden(refs.engChip, vup);
  if (vup) {
    setText(refs.gVal, f1(v.genTps));
    setText(refs.pVal, f1(v.cacheTps));
    setText(refs.rVal, (v.running == null ? '—' : v.running) + '/' + (v.maxSeqs == null ? '—' : v.maxSeqs));
    var wt = v.waiting;
    setText(refs.rWait, wt == null ? '— wait' : '+' + wt + ' wait');
    setChip(refs.rWait, wt == null ? null : wt === 0 ? 'ok' : wt <= 4 ? 'warn' : 'crit');
    setHidden(refs.rSat, !(v.running != null && v.maxSeqs != null && v.running >= v.maxSeqs));
    setText(refs.tVal, f2(v.ttft));
    setText(refs.dVal, v.itl ? f1(1000 / v.itl) : '—');
    setText(refs.dSub, '(' + f1(v.itl) + ' ms)');
    var kv = v.kvPct;
    setText(refs.kvPct, kv == null ? '—' : Math.round(kv) + '%');
    setText(refs.kvTok, kv == null ? '— / 930K tok' : fmtK(Math.round(kv / 100 * KV_POOL)) + ' / ' + fmtK(KV_POOL) + ' tok');
    setMeter(refs.kvFill, kv);
    setDot(refs.kvDot, lvl(kv, TH.kv));
    var sp = v.spec;
    setText(refs.sdAccept, sp ? f1(sp.accept) : '—');
    setText(refs.sdMean, sp ? f1(sp.meanLen) : '—');
    var pp = (sp && sp.perPos) || [];
    for (var j = 0; j < 3; j++) {
      setMeter(refs.ppF[j], pp[j] == null ? 0 : pp[j]);
      setText(refs.ppV[j], pp[j] == null ? '—' : pct0(pp[j]));
    }
    var pf = v.prefix;
    setText(refs.sdPrefix, 'prefix cache ' + (pf ? pct0(pf.roll) : '—') + ' (1m) · ' + (pf ? pct0(pf.life) : '—') + ' (life)');
  } else {
    dashKpis();
  }

  for (var i = 0; i < 2; i++) {
    var nr = refs.node[i];
    var n = d.nodes ? d.nodes[NODE_KEYS[i]] : null;
    var up = !!(n && n.up);
    if (nr.card.__up !== up) {
      nr.card.__up = up;
      nr.card.classList.toggle('offline', !up);
    }
    setHidden(nr.off, up);
    var ds = up ? 'ok' : 'crit';
    if (nr.dot.__s !== ds) { nr.dot.__s = ds; nr.dot.className = 'ndot ' + ds; }
    if (up) {
      var g = n.gpu;
      setText(nr.temp, g ? f0(g.temp) : '—');
      setDot(nr.tempDot, g ? lvl(g.temp, TH.temp) : null);
      setText(nr.power, g ? f1(g.power) : '—');
      setText(nr.util, g ? f0(g.util) : '—');
      setText(nr.clock, g ? f0(g.clock) : '—');
      var m = n.mem;
      setText(nr.memTxt, m ? f1(m.used) + ' / ' + f1(m.total) + ' GB · ' + f0(m.pct) + '%' : '—');
      setMeter(nr.memFill, m ? m.pct : 0);
      setDot(nr.memDot, m ? lvl(m.pct, TH.mem) : null);
      var c = n.cpu;
      setText(nr.cpuTxt, c ? f0(c.pct) + '%' : '—');
      setMeter(nr.cpuFill, c ? c.pct : 0);
      var cUp = !!(n.ctr && n.ctr.vllm);
      setText(nr.ctrTxt, CTR_NAMES[i] + ' ' + (cUp ? 'up' : 'down'));
      setChip(nr.ctr, cUp ? 'ok' : 'crit');
    } else {
      setText(nr.temp, '—'); setDot(nr.tempDot, null);
      setText(nr.power, '—'); setText(nr.util, '—'); setText(nr.clock, '—');
      setText(nr.memTxt, '—'); setMeter(nr.memFill, 0); setDot(nr.memDot, null);
      setText(nr.cpuTxt, '—'); setMeter(nr.cpuFill, 0);
      setText(nr.ctrTxt, CTR_NAMES[i] + ' —');
      setChip(nr.ctr, null);
    }
  }
}

/* ---------------- buffer pushes (idempotent per snapshot t) ---------------- */
function pushBuffers(d){
  if (d.t === lastPushedT) return;
  lastPushedT = d.t;
  var t = d.t, v = d.vllm, vok = !!(v && v.up);
  pushPt(DS.gen, t, vok ? v.genTps : null);
  pushPt(DS.cacheHit, t, vok ? v.cacheTps : null);
  pushPt(DS.compute, t, vok ? v.computeTps : null);
  pushPt(DS.running, t, vok ? v.running : null);
  pushPt(DS.waiting, t, vok ? v.waiting : null);
  pushPt(DS.kv, t, vok ? v.kvPct : null);
  pushPt(DS.accept, t, vok && v.spec ? v.spec.accept : null);
  for (var i = 0; i < 2; i++) {
    var n = d.nodes ? d.nodes[NODE_KEYS[i]] : null;
    var up = !!(n && n.up);
    pushPt(DS.temp[i], t, up && n.gpu ? n.gpu.temp : null);
    pushPt(DS.power[i], t, up && n.gpu ? n.gpu.power : null);
    if (up && n.cpu && n.cpu.pct != null) SP.cpu[i].push(n.cpu.pct);
  }
  if (vok) {
    SP.gen.push(v.genTps);
    SP.prompt.push(v.cacheTps);
    SP.run.push(v.running);
    if (v.ttft != null) SP.ttft.push(v.ttft * 1000); /* spark ring kept in ms */
  }
}

/* ---------------- frame: one rAF per snapshot ---------------- */
function frame(){
  rafId = 0;
  var d = latestSnap;
  if (!d) return;
  applyDom(d);
  pushBuffers(d);
  paintSparks();
  updateCharts();
}

/* ---------------- SSE handlers ---------------- */
function onHello(e){
  var d = JSON.parse(e.data);
  if (d.model) {
    setText(refs.model, String(d.model.id));
    setText(refs.ctx, 'ctx ' + fmtK(d.model.maxContext));
  }
  if (d.nodes && d.nodes.length) {
    var head = null, worker = null, i;
    for (i = 0; i < d.nodes.length; i++) {
      if (d.nodes[i].role === 'head' && !head) head = d.nodes[i];
      else if (!worker) worker = d.nodes[i];
    }
    if (!head) head = d.nodes[0];
    if (!worker) worker = d.nodes[1] || d.nodes[0];
    var ordered = [head, worker];
    for (i = 0; i < 2; i++) {
      NODE_KEYS[i] = ordered[i].host;
      setText(refs.node[i].name, String(ordered[i].host));
      setText(refs.node[i].badge, ordered[i].role === 'head' ? 'HEAD' : 'WORKER');
      setText(refs.node[i].sub, 'NVIDIA GB10 · ' + ordered[i].ip);
    }
  }
  lastSnapshotAt = Date.now();
  setConn('live');
}

function onHistory(e){
  var h = JSON.parse(e.data);
  var t = h.t || [], s = h.s || {};
  var start = Math.max(0, t.length - MAX_PTS);
  function fill(arr, vals){
    arr.length = 0;
    if (!vals) return;
    for (var i = start; i < t.length; i++) arr.push({ x: t[i], y: vals[i] == null ? null : vals[i] });
  }
  fill(DS.gen, s.genTps);
  fill(DS.cacheHit, s.cacheTps);
  fill(DS.compute, s.computeTps);
  fill(DS.running, s.running);
  fill(DS.waiting, s.waiting);
  fill(DS.kv, s.kvPct);
  fill(DS.accept, s.accept);
  fill(DS.temp[0], s.temp0);
  fill(DS.temp[1], s.temp1);
  fill(DS.power[0], s.power0);
  fill(DS.power[1], s.power1);
  function hydrate(sp, vals){
    sp.reset();
    if (!vals) return;
    for (var i = Math.max(0, t.length - 64); i < t.length; i++) if (vals[i] != null) sp.push(vals[i]);
  }
  hydrate(SP.gen, s.genTps);
  hydrate(SP.prompt, s.cacheTps);
  hydrate(SP.run, s.running);
  hydrate(SP.ttft, s.ttftMs); /* already ms; live pushes ttft*1000 to match */
  hydrate(SP.cpu[0], s.cpu0);
  hydrate(SP.cpu[1], s.cpu1);
  lastPushedT = t.length ? t[t.length - 1] : 0;
  if (document.hidden) { dirty = true; return; }
  updateCharts();
  paintSparks();
}

function onSnapshot(e){
  var d = JSON.parse(e.data); /* handler only parses + stores; paints in rAF */
  lastSnapshotAt = Date.now();
  latestSnap = d;
  setConn('live');
  if (document.hidden) { pushBuffers(d); dirty = true; return; }
  if (!rafId) rafId = requestAnimationFrame(frame);
}

var es = new EventSource('/events');
es.addEventListener('hello', onHello);
es.addEventListener('history', onHistory);
es.addEventListener('snapshot', onSnapshot);
es.onerror = function(){ setConn('reconnecting'); };
/* On auto-reconnect (server retry: 2000) the server resends hello + history;
   onHistory replaces chart buffers and spark rings wholesale — idempotent. */

/* ---------------- 1s watchdog: clock + staleness ---------------- */
setInterval(function(){
  var now = Date.now();
  setText(refs.clock, fmtHM.format(now));
  if (connState === 'reconnecting' || !lastSnapshotAt) return;
  var age = now - lastSnapshotAt;
  if (age > 10000) setConn('stale', Math.round(age / 1000));
  else setConn('live');
}, 1000);

/* ---------------- visibility gate ---------------- */
document.addEventListener('visibilitychange', function(){
  if (document.hidden) return;
  if (dirty) {
    dirty = false;
    if (latestSnap) applyDom(latestSnap);
    paintSparks();
    updateCharts();
  }
});

/* ---------------- resize: sparklines only (charts self-manage) ---------------- */
var rsTimer = 0;
window.addEventListener('resize', function(){
  clearTimeout(rsTimer);
  rsTimer = setTimeout(function(){
    for (var i = 0; i < ALL_SPARKS.length; i++) { ALL_SPARKS[i].resize(); ALL_SPARKS[i].paint(); }
  }, 150);
});

})();
