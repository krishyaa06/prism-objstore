#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { ObjectStore, ReedSolomon, durability, md5, crc32 } from "../src/index.js";
import { c, table, header, fail, bar } from "../src/lib/cli.js";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (n, d) => { const i = rest.indexOf("--" + n); return i >= 0 ? rest[i + 1] : d; };
const pos = rest.filter((x, i) => !x.startsWith("--") && !(rest[i - 1] || "").startsWith("--"));
const HELP = `${c.bold("objstore")} — Prism Objstore: erasure-coded, S3-compatible object storage

  objstore serve [--port 9000] [--k 6 --m 3 --nodes 12 --zones 3]   start the S3-compatible HTTP API
  objstore encode <file> [--k 6 --m 3]      split a file into shards, drop m of them, rebuild, verify
  objstore demo [--k 6 --m 3]               upload, kill a zone, degraded read, repair, bit rot + scrub
  objstore durability [--afr 0.02 --repair 6]   compare RS layouts with 3x replication
  objstore bench [--mb 64 --k 10 --m 4]      encode / reconstruct throughput
`;
const KB = (b) => (b / 1024).toFixed(1) + " KB";
try {
  if (!cmd || cmd === "-h" || cmd === "--help") console.log(HELP);
  else if (cmd === "serve") {
    const { createServer } = await import("../src/node/server.js");
    const store = new ObjectStore({ k: +flag("k", 6), m: +flag("m", 3), nodes: +flag("nodes", 12), zones: +flag("zones", 3) }), port = +flag("port", 9000);
    createServer(store, { log: (l) => console.log(c.dim(new Date().toISOString().slice(11, 19)) + " " + l) }).listen(port, () => {
      console.log(header("objstore", `RS(${store.k},${store.m}) · ${store.nodes.length} nodes · ${store.zones.length} zones · http://localhost:${port}`) + "\n");
      console.log(c.dim(`  curl -X PUT localhost:${port}/photos\n  curl -T cat.jpg localhost:${port}/photos/cat.jpg\n  curl -X POST localhost:${port}/_admin/fail/node-01\n  curl localhost:${port}/photos/cat.jpg -o out.jpg   # degraded read\n  aws --endpoint-url http://localhost:${port} --no-sign-request s3 ls s3://photos\n`));
    });
  } else if (cmd === "encode") {
    const f = pos[0] || fail("usage: objstore encode <file>"), data = new Uint8Array(readFileSync(f)), k = +flag("k", 6), m = +flag("m", 3), rs = new ReedSolomon(k, m);
    let t = performance.now(); const sh = rs.encode(data), te = performance.now() - t;
    console.log(header(f, `${KB(data.length)} · RS(${k},${m}) · shard ${KB(sh[0].length)} · overhead ${((k + m) / k).toFixed(2)}×`) + "\n");
    console.log(table(sh.map((s, i) => [i < k ? c.cyan("data " + i) : c.magenta("parity " + (i - k)), KB(s.length), crc32(s).toString(16).padStart(8, "0"), [...s.subarray(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join(" ")]), { head: ["shard", "size", "crc32", "first bytes"] }));
    const drop = [...Array(k + m).keys()].sort(() => Math.random() - 0.5).slice(0, m), lost = sh.map((s, i) => (drop.includes(i) ? null : s));
    t = performance.now(); rs.reconstruct(lost); const tr = performance.now() - t, out = rs.join(lost, data.length);
    console.log(`\n  dropped shards ${c.red(drop.sort((a, b) => a - b).join(", "))} → rebuilt in ${tr.toFixed(1)}ms (encode ${te.toFixed(1)}ms)`);
    console.log(`  md5 original ${md5(data)}\n  md5 rebuilt  ${md5(out)}  ${md5(out) === md5(data) ? c.green("✓ identical") : c.red("✗ mismatch")}`);
  } else if (cmd === "demo") {
    const s = new ObjectStore({ k: +flag("k", 6), m: +flag("m", 3), stripeSize: 256 * 1024 }); s.createBucket("media", { versioning: true });
    const files = Array.from({ length: 24 }, (_, i) => ({ key: `2026/10/img-${i}.jpg`, data: new Uint8Array(50000 + i * 21000).map((_, j) => (j * (i + 7)) & 255) }));
    for (const f of files) s.putObject("media", f.key, f.data);
    const show = (label) => { const h = s.health(), u = s.usage(); console.log(`  ${label.padEnd(34)} healthy ${c.green(String(h.healthy).padStart(3))}  degraded ${c.yellow(String(h.degraded).padStart(3))}  at-risk ${c.red(String(h.atRisk).padStart(3))}  lost ${(h.lost ? c.red : c.dim)(String(h.lost))}  ${c.dim(`stored ${(u.stored / 1048576).toFixed(1)} MB for ${(u.raw / 1048576).toFixed(1)} MB (${u.overhead.toFixed(2)}×)`)}`); };
    console.log(header("demo", `RS(${s.k},${s.m}) across ${s.nodes.length} nodes in ${s.zones.length} zones`) + "\n"); show("24 objects uploaded");
    for (const n of s.nodes.filter((x) => x.zone === "zone-a")) s.fail(n.id); show("zone-a down (4 nodes)");
    const ok = files.every((f) => { const r = s.getObject("media", f.key, { repair: false }); return md5(r.body) === md5(f.data); });
    console.log(`  ${"read all 24 objects".padEnd(34)} ${ok ? c.green("✓ every byte correct") : c.red("✗")}  ${c.dim(`(${s.stats.degradedReads} degraded stripe reads)`)}`);
    console.log(`  ${"repair onto zones b + c".padEnd(34)} rebuilt ${s.repair()} shards ${c.dim("(8 healthy nodes for 9-shard stripes: one shard per stripe waits for capacity)")}`); show("after repair");
    for (const n of s.nodes.filter((x) => x.zone === "zone-a")) { s.recover(n.id); s.destroy(n.id); }
    const rot = Array.from({ length: 5 }, () => s.bitrot()).filter(Boolean); console.log(`  ${"silent bit rot in 5 shards".padEnd(34)} ${rot.map((r) => `${r.stripe}.${r.shard}@${r.node}`).join(" ")}`);
    console.log(`  ${"scrub (crc32 every shard)".padEnd(34)} found ${c.red(s.scrub())} corrupt → rebuilt ${s.repair()}`); show("after scrub + repair");
    const r = s.getObject("media", files[3].key, { range: [1000, 1015] }); console.log(`  ${"range GET bytes 1000-1015".padEnd(34)} ${[...r.body].map((b) => b.toString(16).padStart(2, "0")).join(" ")}`);
  } else if (cmd === "durability") {
    const afr = +flag("afr", 0.02), repairHours = +flag("repair", 6);
    const rows = [[1, 2, "3× replication"], [4, 2, "RS(4,2)"], [6, 3, "RS(6,3)"], [10, 4, "RS(10,4) · HDFS/Azure-like"], [12, 4, "RS(12,4)"], [17, 3, "RS(17,3) · wide stripe"]].map(([k, m, l]) => { const d = durability({ k, m, afr, repairHours }); return [l, d.overhead.toFixed(2) + "×", bar(Math.min(1, d.nines / 20), 20), (d.nines > 12 ? c.green : d.nines > 9 ? c.yellow : c.red)(d.nines.toFixed(1) + " nines"), `${m} of ${k + m}`]; });
    console.log(header("durability", `independent failures · AFR ${(afr * 100).toFixed(1)}% · repair window ${repairHours}h`) + "\n"); console.log(table(rows, { head: ["layout", "overhead", "", "annual durability", "can lose"] }));
  } else if (cmd === "bench") {
    const mb = +flag("mb", 64), k = +flag("k", 10), m = +flag("m", 4), rs = new ReedSolomon(k, m), data = new Uint8Array(mb * 1048576); for (let i = 0; i < data.length; i += 4096) data[i] = i & 255;
    let t = performance.now(); const sh = rs.encode(data); const te = performance.now() - t; const lost = sh.map((s, i) => (i < m ? null : s)); t = performance.now(); rs.reconstruct(lost); const tr = performance.now() - t;
    console.log(header("bench", `${mb} MB · RS(${k},${m})`) + "\n"); console.log(table([["encode", (mb / te * 1000).toFixed(0) + " MB/s", te.toFixed(0) + "ms"], [`rebuild ${m} data shards`, (mb / tr * 1000).toFixed(0) + " MB/s", tr.toFixed(0) + "ms"]], { head: ["op", "throughput", "time"] }));
  } else fail(`unknown command ${cmd}\n\n${HELP}`);
} catch (e) { fail(e.message); }
