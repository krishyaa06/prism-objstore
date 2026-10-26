import { ObjectStore, durability } from "../src/index.js";
import { $, h, esc, fmt, toast, Loop, bindLoop, LogView, Kpis, Chart, fit, css, hexA } from "./pro.js";

const DATA = "#00d2ff", PAR = "#a78bfa", BAD = "#ff5c8a", REP = "#ffb547";
let S, K = 6, M = 3, objs = [], seq = 0, parts = [], flash = new Map(), repairN = 0, auto = true, uploadMsg = null;
const log = new LogView($("#log"), 220);
let rr = 12345; const rand = () => ((rr = (rr * 48271) % 2147483647) / 2147483647);
function build(k, m) {
  K = k; M = m; S = new ObjectStore({ k, m, nodes: 15, zones: 3, stripeSize: 64 * 1024 }); S.createBucket("media", { versioning: false }); objs = []; parts = [];
  S.on((e) => {
    if (e.type === "stripe") { e.nodes.forEach((n, i) => parts.length < 400 && parts.push({ to: n, k: -i * 0.04, col: i < K ? DATA : PAR, from: "up" })); }
    else if (e.type === "repair") { repairN++; const st = S.stripes.get(e.stripe), src = st?.shards.find((s) => s.node !== e.to && S.node(s.node).up)?.node; if (src && parts.length < 400) parts.push({ from: src, to: e.to, k: 0, col: REP }); if (Math.random() < 0.12) log.html(`<span class="warn">REPAIR</span> ${e.stripe}.${e.shard} <span class="dim">${e.from} → ${e.to}</span>`); }
    else if (e.type === "corrupt") { flash.set(e.node, { t: performance.now(), col: BAD }); log.html(`<span class="bad">CRC MISMATCH</span> ${e.stripe}.${e.shard} on ${e.node} <span class="dim">shard dropped, will be rebuilt</span>`); }
    else if (e.type === "node-down") log.html(`<span class="bad">DOWN</span> ${e.node}`);
    else if (e.type === "node-up") log.html(`<span class="ok">UP</span> ${e.node}`);
    else if (e.type === "lost") log.html(`<span class="bad">DATA LOSS</span> stripe ${e.stripe}: ${e.have}/${K + M} shards`);
  });
  for (let i = 0; i < 40; i++) upload(true);
  parts = [];
}
function upload(quiet = false) {
  const size = Math.round(20000 + rand() * 260000), key = `uploads/2026/10/${["img", "vid", "doc", "log"][seq % 4]}-${++seq}.${["jpg", "mp4", "pdf", "gz"][seq % 4]}`;
  const data = new Uint8Array(size); for (let i = 0; i < size; i += 64) data[i] = (i * seq) & 255;
  try { S.putObject("media", key, data); objs.push({ key, size }); if (!quiet) uploadMsg = { key, size, stripes: Math.ceil(size / S.stripeSize), t: performance.now() }; } catch (e) { if (!quiet) log.html(`<span class="bad">PUT FAILED</span> ${esc(e.message)}`); }
  while (objs.length > 120) { const o = objs.shift(); S.deleteObject("media", o.key); } // lifecycle rule: keep the newest 120
}
build(6, 3);

const kp = new Kpis($("#kpis"), [
  { key: "objs", label: "Objects", tone: "acc" }, { key: "raw", label: "Logical data", fmt: fmt.bytes }, { key: "ovh", label: "Overhead", fmt: (v) => v.toFixed(2) + "×" },
  { key: "healthy", label: "Healthy", fmt: (v) => (v * 100).toFixed(1) + "%" }, { key: "risk", label: "Degr · risk" }, { key: "nines", label: "Nines", fmt: (v) => v.toFixed(1) },
]);
const ch1 = new Chart($("#ch1"), { series: [{ label: "healthy", color: "#22e3a1" }, { label: "degraded", color: REP }, { label: "at risk", color: BAD }], min: 0, points: 120, area: false, fmtY: (v) => v.toFixed(0) });
const ch2 = new Chart($("#ch2"), { series: [{ label: "rebuilt shards / s", color: "--accent" }], min: 0, points: 120, fmtY: (v) => v.toFixed(0) });

// ---------- cluster canvas ----------
let boxes = [];
function draw() {
  const { ctx, w, h: H } = fit($("#cl")); ctx.clearRect(0, 0, w, H);
  const mono = "JetBrains Mono, monospace", top = w < 600 ? 100 : 92, zones = S.zones, colW = (w - 24) / 3, now = performance.now();
  // client / upload band
  const cx = w / 2; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillStyle = hexA(css("--accent"), 0.1); ctx.strokeStyle = hexA(css("--accent"), 0.6); ctx.beginPath(); ctx.roundRect(cx - 120, 34, 240, 34, 10); ctx.fill(); ctx.stroke();
  const um = uploadMsg && now - uploadMsg.t < 1500 ? uploadMsg : null;
  ctx.fillStyle = "#e8ecfa"; ctx.font = `600 11px ${mono}`; ctx.fillText(um ? `PUT ${um.key.split("/").pop()} · ${fmt.bytes(um.size)}` : `S3 API · RS(${K},${M}) · ${K === 1 ? "replicas" : "stripes"} of 64 KB`, cx, 42);
  ctx.fillStyle = "#5f6884"; ctx.font = `10px ${mono}`; ctx.fillText(um ? `${um.stripes} stripe${um.stripes > 1 ? "s" : ""} × (${K} data + ${M} parity)` : `${S.stripes.size} stripes · ${(S.stripes.size * (K + M)).toLocaleString()} shards`, cx, 56);
  // shard strip under the band
  const sw = Math.min(16, 220 / (K + M)); for (let i = 0; i < K + M; i++) { ctx.fillStyle = hexA(i < K ? DATA : PAR, 0.85); ctx.fillRect(cx - ((K + M) * (sw + 2)) / 2 + i * (sw + 2), 74, sw, 6); }
  boxes = [];
  zones.forEach((z, zi) => {
    const x0 = 12 + zi * colW, nodes = S.nodes.filter((n) => n.zone === z), up = nodes.filter((n) => n.up).length;
    ctx.fillStyle = "#ffffff04"; ctx.strokeStyle = "#2a3560"; ctx.beginPath(); ctx.roundRect(x0 + 3, top, colW - 6, H - top - 28, 12); ctx.fill(); ctx.stroke();
    ctx.textAlign = "left"; ctx.font = `600 11px ${mono}`; ctx.fillStyle = up === nodes.length ? "#c9d1f0" : BAD; ctx.fillText(z, x0 + 14, top + 16);
    ctx.fillStyle = "#5f6884"; ctx.font = `10px ${mono}`; ctx.textAlign = "right"; ctx.fillText(`${up}/${nodes.length} up`, x0 + colW - 14, top + 16);
    const nh = (H - top - 58 - nodes.length * 8) / nodes.length, max = Math.max(1, ...S.nodes.map((n) => n.bytes));
    nodes.forEach((n, i) => {
      const x = x0 + 12, y = top + 30 + i * (nh + 8), bw = colW - 24, f = flash.get(n.id), fa = f ? Math.max(0, 1 - (now - f.t) / 900) : 0;
      boxes.push({ id: n.id, x, y, w: bw, h: nh });
      ctx.fillStyle = n.up ? "#0d1430" : "#2a0d18"; ctx.strokeStyle = n.up ? (fa ? hexA(f.col, 0.4 + fa * 0.6) : "#2a3560") : BAD; ctx.lineWidth = fa ? 2 : 1; ctx.beginPath(); ctx.roundRect(x, y, bw, nh, 9); ctx.fill(); ctx.stroke(); ctx.lineWidth = 1;
      ctx.textAlign = "left"; ctx.font = `600 10.5px ${mono}`; ctx.fillStyle = n.up ? "#e8ecfa" : BAD; ctx.fillText(n.id, x + 10, y + 13);
      const tight = bw < 160; ctx.font = `10px ${mono}`; ctx.fillStyle = n.up ? "#5f6884" : BAD;
      if (tight) { ctx.textAlign = "left"; ctx.fillText(n.up ? `${n.shards.size} shards` : "OFFLINE", x + 10, y + 27); } else { ctx.textAlign = "right"; ctx.fillText(n.up ? `${n.shards.size} shards` : "OFFLINE", x + bw - 10, y + 13); }
      // disk bar
      const by = y + nh - 12; ctx.fillStyle = "#ffffff10"; ctx.fillRect(x + 10, by, bw - 20, 4); ctx.fillStyle = n.up ? css("--accent") : hexA(BAD, 0.5); ctx.fillRect(x + 10, by, (bw - 20) * (n.bytes / max), 4);
      if (nh > (tight ? 52 : 40)) { ctx.textAlign = "left"; ctx.fillStyle = "#5f6884"; ctx.fillText(fmt.bytes(n.bytes), x + 10, y + (tight ? 41 : 27)); }
      if (!n.up) { ctx.strokeStyle = hexA(BAD, 0.35); ctx.beginPath(); ctx.moveTo(x + 4, y + 4); ctx.lineTo(x + bw - 4, y + nh - 4); ctx.stroke(); }
    });
  });
  // particles
  const center = (id) => { const b = boxes.find((q) => q.id === id); return b ? [b.x + b.w / 2, b.y + b.h / 2] : null; };
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]; p.k += 0.035; if (p.k >= 1) { parts.splice(i, 1); continue; } if (p.k < 0) continue;
    const A = p.from === "up" ? [cx, 70] : center(p.from), B = center(p.to); if (!A || !B) { parts.splice(i, 1); continue; }
    const t = p.k, ease = t * t * (3 - 2 * t), x = A[0] + (B[0] - A[0]) * ease, y = A[1] + (B[1] - A[1]) * ease - Math.sin(Math.PI * t) * (p.from === "up" ? 0 : 30);
    ctx.fillStyle = p.col; ctx.shadowColor = p.col; ctx.shadowBlur = 6; ctx.beginPath(); ctx.arc(x, y, p.col === REP ? 3 : 2.2, 0, 7); ctx.fill(); ctx.shadowBlur = 0;
  }
  // legend
  ctx.font = `10px ${mono}`; ctx.textAlign = "left"; let lx = 14; for (const [n, c] of [["data", DATA], ["parity", PAR], ["repair", REP], ["corrupt", BAD]]) { ctx.fillStyle = c; ctx.fillRect(lx, H - 16, 8, 8); ctx.fillStyle = "#8d94ad"; ctx.fillText(n, lx + 12, H - 12); lx += ctx.measureText(n).width + 26; }
}
$("#cl").addEventListener("click", (e) => {
  const r = e.target.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, b = boxes.find((q) => x >= q.x && x <= q.x + q.w && y >= q.y && y <= q.y + q.h);
  if (!b) return; const n = S.node(b.id); n.up ? S.fail(n.id) : S.recover(n.id); draw(); tick(0, true);
});

// ---------- PUT / GET panel ----------
function strip(states) { $("#strip").innerHTML = states.map((s, i) => `<span class="${s}">${i < K ? "d" + i : "p" + (i - K)}</span>`).join(""); }
$("#put").onclick = () => {
  const key = $("#key").value.trim() || "notes/hello.txt"; try { const v = S.putObject("media", key, $("#body").value); $("#etag").textContent = "etag " + v.etag.slice(0, 10) + "…"; const st = S.stripes.get(v.stripes[0]); strip(st.shards.map((s) => (s.idx < K ? "d" : "p"))); $("#out").innerHTML = `<div><span class="ok">200</span> PUT ${esc(key)} <span class="dim">${v.size} B → ${v.stripes.length} stripe · shards on ${st.shards.map((s) => s.node.slice(5)).join(" ")}</span></div>`; uploadMsg = { key, size: v.size, stripes: v.stripes.length, t: performance.now() }; } catch (e) { $("#out").innerHTML = `<div class="bad">${esc(e.message)}</div>`; }
};
$("#get").onclick = () => {
  const key = $("#key").value.trim(); let v; try { v = S.head("media", key); } catch (e) { $("#out").innerHTML = `<div class="bad">404 ${esc(e.message)}</div>`; return; }
  const st = S.stripes.get(v.stripes[0]), states = st.shards.map((s) => { const n = S.node(s.node); return n.up && n.shards.has(st.id + "." + s.idx) ? (s.idx < K ? "d" : "p") : "x"; });
  const before = S.stats.degradedReads;
  try { const r = S.getObject("media", key, { repair: false }), deg = S.stats.degradedReads > before; strip(states.map((s, i) => (s === "x" && i < K ? "r" : s)));
    $("#out").innerHTML = `<div><span class="ok">200</span> ${deg ? '<span class="warn">degraded read</span> · rebuilt ' + states.filter((s, i) => s === "x" && i < K).length + " data shard(s) from parity" : '<span class="acc">fast path</span> · all data shards online'}</div><pre style="margin:6px 0 0;white-space:pre-wrap">${esc(new TextDecoder().decode(r.body))}</pre>`;
  } catch (e) { strip(states); $("#out").innerHTML = `<div class="bad">500 ${esc(e.code || "")}: ${esc(e.message)}</div>`; }
};

// ---------- controls ----------
$("#layout").onchange = (e) => { const [k, m] = e.target.value.split(",").map(Number); build(k, m); toast(k === 1 ? "3× replication: RS(1,2) — every shard is a full copy" : `RS(${k},${m}): ${k} data + ${m} parity, survives any ${m} failures`); log.html(`<span class="acc">LAYOUT</span> RS(${k},${m}) · overhead ${((k + m) / k).toFixed(2)}×`); $("#put").click(); };
$("#zone").onclick = () => { const zn = S.nodes.filter((n) => n.zone === "zone-a"), down = zn.every((n) => !n.up); for (const n of zn) down ? S.recover(n.id) : S.fail(n.id); $("#zone").textContent = down ? "Fail zone-a" : "Recover zone-a"; toast(down ? "zone-a back online" : "zone-a lost power: 5 nodes offline"); tick(0, true); };
$("#rot").onclick = () => { for (let i = 0; i < 3; i++) { const r = S.bitrot(rand); if (r) { flash.set(r.node, { t: performance.now(), col: BAD }); log.html(`<span class="dim">bit rot injected in ${r.stripe}.${r.shard} on ${r.node}</span>`); } } toast("3 shards silently corrupted. The next scrub will find them."); };
$("#replace").onclick = () => { const dead = S.nodes.filter((n) => !n.up); for (const n of dead) { S.destroy(n.id); S.recover(n.id); } $("#zone").textContent = "Fail zone-a"; toast(dead.length ? `${dead.length} empty replacement disks joined` : "no failed nodes"); };
$("#auto").onclick = (e) => { auto = !auto; e.target.classList.toggle("on", auto); toast(auto ? "Auto-repair on: missing shards are rebuilt in the background" : "Auto-repair off: failures accumulate"); };

let acc = 0, upAcc = 0, scrubAcc = 0, repAcc = 0, lastRep = 0;
function tick(dt, force = false) {
  upAcc += dt; while (upAcc > 0.45) { upAcc -= 0.45; upload(); }
  if (auto) { repAcc += dt; if (repAcc > 0.25) { repAcc = 0; S.repair(2); } scrubAcc += dt; if (scrubAcc > 4) { scrubAcc = 0; const n = S.scrub(); if (n) toast(`scrub found ${n} corrupt shard${n > 1 ? "s" : ""}`); } }
  acc += dt;
  if (acc >= 0.5 || force) {
    const hh = S.health(), u = S.usage(), d = durability({ k: K, m: M, afr: 0.02, repairHours: auto ? 6 : 720 });
    kp.set({ objs: objs.length, raw: u.raw, ovh: u.overhead, healthy: hh.stripes ? hh.healthy / hh.stripes : 1, risk: `${hh.degraded} · ${hh.atRisk}${hh.lost ? " · " + hh.lost + " lost" : ""}`, nines: d.nines });
    kp.tone("risk", hh.lost ? "bad" : hh.atRisk ? "warn" : ""); kp.tone("healthy", hh.healthy === hh.stripes ? "ok" : "warn");
    if (!force) { ch1.push(hh.healthy, hh.degraded, hh.atRisk); ch2.push((repairN - lastRep) / acc); lastRep = repairN; acc = 0; }
  }
}
const loop = new Loop((dt) => { tick(dt); draw(); });
bindLoop(loop, $("#sim"));
tick(0, true); draw(); $("#put").click(); loop.start();
setTimeout(() => $("#zone").click(), 1500);
setTimeout(() => $("#get").click(), 2600);
addEventListener("resize", draw);
