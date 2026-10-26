import { test } from "node:test";
import assert from "node:assert/strict";
import { ReedSolomon, ObjectStore, gf, md5, crc32, durability } from "../src/index.js";
import { createServer } from "../src/node/server.js";

const rnd = (n, seed = 1) => { let x = seed; return Uint8Array.from({ length: n }, () => ((x = (x * 1103515245 + 12345) >>> 0) >>> 16) & 255); };
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

test("GF(256) field laws and matrix inversion", () => {
  for (let a = 1; a < 256; a += 7) { assert.equal(gf.mul(a, gf.inv(a)), 1); for (let b = 1; b < 256; b += 11) { assert.equal(gf.mul(a, b), gf.mul(b, a)); assert.equal(gf.div(gf.mul(a, b), b), a); } }
  const M = [Uint8Array.of(3, 7, 1), Uint8Array.of(9, 2, 5), Uint8Array.of(4, 8, 6)], I = gf.invert(M);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) { let s = 0; for (let t = 0; t < 3; t++) s ^= gf.mul(M[i][t], I[t][j]); assert.equal(s, i === j ? 1 : 0); }
});
test("any k of k+m shards reconstruct the data (exhaustive for RS(4,3))", () => {
  const rs = new ReedSolomon(4, 3), data = rnd(1001), sh = rs.encode(data);
  for (let mask = 0; mask < 1 << 7; mask++) {
    const keep = [...Array(7).keys()].filter((i) => mask & (1 << i)); if (keep.length < 4) continue;
    const s = sh.map((x, i) => (keep.includes(i) ? x : null)); rs.reconstruct(s); assert.ok(eq(rs.join(s, data.length), data)); assert.ok(rs.verify(s));
  }
  assert.throws(() => rs.reconstruct([sh[0], null, sh[2], null, null, null, sh[6]]), /unrecoverable/);
});
test("checksums: crc32 and md5 test vectors", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  assert.equal(md5(""), "d41d8cd98f00b204e9800998ecf8427e"); assert.equal(md5("The quick brown fox jumps over the lazy dog"), "9e107d9d372bb6826bd81d3542a419d6");
});
test("placement spreads a stripe over distinct nodes with at most n/zones per zone", () => {
  const s = new ObjectStore({ k: 6, m: 3, stripeSize: 4096 }); s.createBucket("bkt"); s.putObject("bkt", "x", rnd(40000));
  for (const st of s.stripes.values()) { const nodes = st.shards.map((x) => x.node); assert.equal(new Set(nodes).size, 9); const z = {}; for (const n of nodes) { const zz = s.node(n).zone; z[zz] = (z[zz] || 0) + 1; } assert.ok(Object.values(z).every((v) => v <= 3)); }
});
test("survives a full zone outage with degraded reads, then repairs", () => {
  const s = new ObjectStore({ k: 6, m: 3, nodes: 15, stripeSize: 8192 }); s.createBucket("bkt"); const d = rnd(100000, 3); s.putObject("bkt", "f", d);
  for (const n of s.nodes.filter((x) => x.zone === "zone-b")) s.fail(n.id);
  assert.ok(eq(s.getObject("bkt", "f", { repair: false }).body, d)); assert.ok(s.stats.degradedReads > 0);
  const rebuilt = s.repair(); assert.ok(rebuilt > 0); const h = s.health(); assert.equal(h.healthy, h.stripes, "10 healthy nodes are enough to fully heal 9-shard stripes");
});
test("more than m failures in a stripe is reported as data loss", () => {
  const s = new ObjectStore({ k: 4, m: 2, nodes: 6 }); s.createBucket("bkt"); s.putObject("bkt", "f", "precious");
  s.fail("node-01"); s.fail("node-02"); s.fail("node-03"); assert.equal(s.health().lost, 1);
  assert.throws(() => s.getObject("bkt", "f"), (e) => e.code === "DataLoss");
});
test("bit rot is caught by crc on read and by scrub, and healed", () => {
  const s = new ObjectStore({ k: 4, m: 2, nodes: 8, stripeSize: 1024 }); s.createBucket("bkt"); const d = rnd(5000, 9); s.putObject("bkt", "f", d);
  let r = 7; const rand = () => ((r = (r * 48271) % 2147483647) / 2147483647);
  for (let i = 0; i < 4; i++) s.bitrot(rand);
  assert.ok(eq(s.getObject("bkt", "f", { repair: false }).body, d), "corrupt shards are ignored on read");
  const bad = s.scrub(); assert.ok(bad >= 1); s.repair(); assert.equal(s.scrub(), 0); assert.equal(s.health().healthy, s.health().stripes);
});
test("ranges, listing with delimiter, versioning and delete markers", () => {
  const s = new ObjectStore({ stripeSize: 100 }); s.createBucket("bkt", { versioning: true }); const d = rnd(1000, 4);
  s.putObject("bkt", "logs/2026/a.txt", d); s.putObject("bkt", "logs/2026/b.txt", "x"); s.putObject("bkt", "logs/2025/c.txt", "y"); s.putObject("bkt", "readme", "z");
  assert.ok(eq(s.getObject("bkt", "logs/2026/a.txt", { range: [95, 305] }).body, d.subarray(95, 306)));
  const l = s.list("bkt", { prefix: "logs/", delimiter: "/" }); assert.deepEqual(l.commonPrefixes, ["logs/2025/", "logs/2026/"]);
  const p = s.list("bkt", { maxKeys: 2 }); assert.equal(p.contents.length, 2); assert.ok(p.truncated); assert.equal(s.list("bkt", { startAfter: p.nextStartAfter }).contents.length, 2);
  const v1 = s.head("bkt", "readme").versionId; s.putObject("bkt", "readme", "z2"); s.deleteObject("bkt", "readme");
  assert.throws(() => s.head("bkt", "readme"), /no key/); assert.equal(new TextDecoder().decode(s.getObject("bkt", "readme", { versionId: v1 }).body), "z");
  assert.equal(s.versions("bkt", "readme").length, 3); assert.equal(s.versions("bkt", "readme")[0].deleteMarker, true);
});
test("multipart upload: S3-style ETag and ordered assembly", () => {
  const s = new ObjectStore({ stripeSize: 4096 }); s.createBucket("bkt"); const id = s.createMultipart("bkt", "big.bin"), a = rnd(10000, 5), b = rnd(7000, 6);
  const e2 = s.uploadPart(id, 2, b), e1 = s.uploadPart(id, 1, a); s.uploadPart(id, 3, "unused");
  const v = s.completeMultipart(id, [{ partNumber: 1, etag: e1 }, { partNumber: 2, etag: `"${e2}"` }]);
  assert.match(v.etag, /^[0-9a-f]{32}-2$/); const all = new Uint8Array(17000); all.set(a); all.set(b, 10000); assert.ok(eq(s.getObject("bkt", "big.bin").body, all));
  assert.throws(() => s.completeMultipart(id, []), /NoSuchUpload|no upload/);
});
test("durability model: RS(6,3) beats 3x replication at half the overhead", () => {
  const r = durability({ k: 1, m: 2 }), e = durability({ k: 6, m: 3 }); assert.ok(e.nines > r.nines); assert.equal(r.overhead, 3); assert.equal(e.overhead, 1.5);
});
test("S3 HTTP API: buckets, put/get/range/head/list, multipart, admin fail", async () => {
  const store = new ObjectStore({ k: 4, m: 2, nodes: 8, stripeSize: 2048 }), srv = createServer(store); await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`, body = rnd(9000, 8);
  try {
    assert.equal((await fetch(base + "/photos", { method: "PUT" })).status, 200);
    const put = await fetch(base + "/photos/cats/1.jpg", { method: "PUT", body, headers: { "content-type": "image/jpeg", "x-amz-meta-owner": "riya" } }); assert.equal(put.headers.get("etag"), `"${md5(body)}"`);
    const head = await fetch(base + "/photos/cats/1.jpg", { method: "HEAD" }); assert.equal(head.headers.get("content-length"), "9000"); assert.equal(head.headers.get("x-amz-meta-owner"), "riya");
    const rg = await fetch(base + "/photos/cats/1.jpg", { headers: { range: "bytes=100-199" } }); assert.equal(rg.status, 206); assert.ok(eq(new Uint8Array(await rg.arrayBuffer()), body.subarray(100, 200)));
    const ls = await (await fetch(base + "/photos?list-type=2&prefix=cats/")).text(); assert.match(ls, /<Key>cats\/1.jpg<\/Key>/); assert.match(ls, /<KeyCount>1<\/KeyCount>/);
    await fetch(base + "/_admin/fail/node-01", { method: "POST" }); await fetch(base + "/_admin/fail/node-02", { method: "POST" });
    assert.ok(eq(new Uint8Array(await (await fetch(base + "/photos/cats/1.jpg")).arrayBuffer()), body), "degraded read over HTTP");
    const init = await (await fetch(base + "/photos/v.mp4?uploads", { method: "POST" })).text(), uid = /<UploadId>(.+)<\/UploadId>/.exec(init)[1];
    const p1 = (await fetch(`${base}/photos/v.mp4?partNumber=1&uploadId=${uid}`, { method: "PUT", body: "hello " })).headers.get("etag");
    const p2 = (await fetch(`${base}/photos/v.mp4?partNumber=2&uploadId=${uid}`, { method: "PUT", body: "world" })).headers.get("etag");
    const done = await (await fetch(`${base}/photos/v.mp4?uploadId=${uid}`, { method: "POST", body: `<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>${p1}</ETag></Part><Part><PartNumber>2</PartNumber><ETag>${p2}</ETag></Part></CompleteMultipartUpload>` })).text();
    assert.match(done, /-2&quot;|-2"/); assert.equal(await (await fetch(base + "/photos/v.mp4")).text(), "hello world");
    const nf = await fetch(base + "/photos/nope"); assert.equal(nf.status, 404); assert.match(await nf.text(), /<Code>NoSuchKey<\/Code>/);
  } finally { srv.close(); }
});
