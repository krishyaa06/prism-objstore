// Erasure-coded object store: buckets, versioning, multipart uploads, zone-aware placement,
// degraded reads, background repair and scrubbing. Nodes are in-memory shard stores.
import { ReedSolomon } from "./rs.js";
import { crc32, md5, md5bytes, hex } from "./checksum.js";
import { murmur3 } from "./lib/hash.js";

export class Node {
  constructor(id, zone) { this.id = id; this.zone = zone; this.up = true; this.shards = new Map(); this.bytes = 0; this.reads = 0; this.writes = 0; }
  put(key, buf) { const old = this.shards.get(key); if (old) this.bytes -= old.length; this.shards.set(key, buf); this.bytes += buf.length; this.writes++; }
  get(key) { if (!this.up) return null; this.reads++; return this.shards.get(key) || null; }
  del(key) { const b = this.shards.get(key); if (b) { this.bytes -= b.length; this.shards.delete(key); } }
}
export class StoreError extends Error { constructor(code, msg, status = 400) { super(msg); this.code = code; this.status = status; } }
const enc = (x) => (typeof x === "string" ? new TextEncoder().encode(x) : x instanceof Uint8Array ? x : new Uint8Array(x));
let VID = 0; const vid = () => (Date.now().toString(36) + (++VID).toString(36).padStart(4, "0")).toUpperCase();

export class ObjectStore {
  constructor({ nodes = 12, zones = 3, k = 6, m = 3, stripeSize = 1 << 20, nodeList = null } = {}) {
    this.rs = new ReedSolomon(k, m); this.k = k; this.m = m; this.stripeSize = stripeSize;
    this.nodes = nodeList || Array.from({ length: nodes }, (_, i) => new Node(`node-${String(i + 1).padStart(2, "0")}`, `zone-${String.fromCharCode(97 + (i % zones))}`));
    if (this.nodes.length < k + m) throw new RangeError(`need at least k+m=${k + m} nodes`);
    this.buckets = new Map(); this.uploads = new Map(); this.stripes = new Map(); this.seq = 0; this.events = [];
    this.stats = { puts: 0, gets: 0, fastReads: 0, degradedReads: 0, repaired: 0, corruptFound: 0, lost: 0, bytesIn: 0, bytesStored: 0 };
  }
  on(fn) { this.events.push(fn); return this; }
  emit(e) { for (const f of this.events) f(e); }
  get zones() { return [...new Set(this.nodes.map((n) => n.zone))]; }
  node(id) { return this.nodes.find((n) => n.id === id) || (() => { throw new StoreError("NoSuchNode", "no node " + id, 404); })(); }
  /** Rendezvous hashing with a per-zone cap so a zone failure costs at most ceil(n/zones) shards. */
  place(stripeId, n = this.rs.n, exclude = new Set()) {
    const cand = this.nodes.filter((x) => x.up && !exclude.has(x.id)).map((x) => ({ x, s: murmur3(stripeId + "/" + x.id) })).sort((a, b) => b.s - a.s);
    const zones = new Set(this.nodes.map((x) => x.zone)).size, cap = Math.ceil(this.rs.n / zones), perZone = {}, out = [];
    for (const { x } of cand) if (out.length < n && (perZone[x.zone] || 0) < cap) { out.push(x); perZone[x.zone] = (perZone[x.zone] || 0) + 1; }
    for (const { x } of cand) if (out.length < n && !out.includes(x)) out.push(x); // relax if a zone is down
    if (out.length < n) throw new StoreError("InsufficientCapacity", `only ${out.length} healthy nodes for ${n} shards`, 503);
    return out;
  }
  _writeStripe(data) {
    const id = "s" + (++this.seq).toString(36).padStart(6, "0"), shards = this.rs.encode(data), nodes = this.place(id);
    const st = { id, len: data.length, shards: shards.map((buf, i) => { nodes[i].put(id + "." + i, buf); return { idx: i, node: nodes[i].id, crc: crc32(buf) }; }) };
    this.stripes.set(id, st); this.stats.bytesStored += shards.length * shards[0].length; this.emit({ type: "stripe", id, nodes: nodes.map((x) => x.id), len: data.length });
    return id;
  }
  _readStripe(id, { repair = false } = {}) {
    const st = this.stripes.get(id), got = new Array(this.rs.n).fill(null); let bad = 0;
    for (const s of st.shards) { const buf = this.node(s.node).get(id + "." + s.idx); if (buf && crc32(buf) === s.crc) got[s.idx] = buf; else if (buf) { bad++; this.stats.corruptFound++; this.emit({ type: "corrupt", stripe: id, shard: s.idx, node: s.node }); } }
    const missingData = got.slice(0, this.k).some((x) => !x);
    if (!missingData) { this.stats.fastReads++; return this.rs.join(got, st.len); }
    const have = got.filter(Boolean).length;
    if (have < this.k) { this.stats.lost++; this.emit({ type: "lost", stripe: id, have }); throw new StoreError("DataLoss", `stripe ${id}: only ${have}/${this.rs.n} shards readable, need ${this.k}`, 500); }
    this.stats.degradedReads++; this.emit({ type: "degraded", stripe: id, have, bad });
    const full = this.rs.reconstruct(got.slice()); if (repair) this._repairStripe(st, full);
    return this.rs.join(full, st.len);
  }
  _repairStripe(st, full) {
    const healthy = new Set(st.shards.filter((s) => { const n = this.node(s.node); const b = n.up && n.shards.get(st.id + "." + s.idx); return b && crc32(b) === s.crc; }).map((s) => s.idx));
    if (healthy.size === this.rs.n) return 0;
    if (!full) { const got = new Array(this.rs.n).fill(null); for (const s of st.shards) if (healthy.has(s.idx)) got[s.idx] = this.node(s.node).shards.get(st.id + "." + s.idx); if (healthy.size < this.k) return -1; full = this.rs.reconstruct(got); }
    const used = new Set(st.shards.filter((s) => healthy.has(s.idx)).map((s) => s.node)); let n = 0;
    for (const s of st.shards) {
      if (healthy.has(s.idx)) continue;
      const old = this.node(s.node);
      const zoneUse = {}; for (const id of used) { const z = this.node(id).zone; zoneUse[z] = (zoneUse[z] || 0) + 1; }
      const target = this.nodes.filter((x) => x.up && !used.has(x.id)).map((x) => ({ x, s: murmur3(st.id + "#" + s.idx + "/" + x.id) })).sort((a, b) => (zoneUse[a.x.zone] || 0) - (zoneUse[b.x.zone] || 0) || b.s - a.s)[0]?.x;
      if (!target) continue; // not enough distinct healthy nodes: stay degraded rather than co-locate shards
      old.del(st.id + "." + s.idx); target.put(st.id + "." + s.idx, full[s.idx]); this.emit({ type: "repair", stripe: st.id, shard: s.idx, from: old.id, to: target.id });
      s.node = target.id; used.add(target.id); n++; this.stats.repaired++;
    }
    return n;
  }
  // ---------- buckets ----------
  createBucket(name, { versioning = false } = {}) {
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(name)) throw new StoreError("InvalidBucketName", "bucket names are 3-63 chars of a-z 0-9 . -");
    if (this.buckets.has(name)) throw new StoreError("BucketAlreadyOwnedByYou", "bucket exists", 409);
    this.buckets.set(name, { name, versioning, created: Date.now(), objects: new Map() }); return this.buckets.get(name);
  }
  bucket(name) { const b = this.buckets.get(name); if (!b) throw new StoreError("NoSuchBucket", "no bucket " + name, 404); return b; }
  deleteBucket(name) { const b = this.bucket(name); if ([...b.objects.values()].some((v) => v.some((x) => !x.deleteMarker))) throw new StoreError("BucketNotEmpty", "bucket is not empty", 409); this.buckets.delete(name); }
  setVersioning(name, on) { this.bucket(name).versioning = on; }
  // ---------- objects ----------
  _stripeAll(data) { const ids = []; for (let o = 0; o < data.length || (o === 0 && !ids.length); o += this.stripeSize) ids.push(this._writeStripe(data.subarray(o, o + this.stripeSize))); return ids; }
  _commit(bucket, key, ver) {
    const b = this.bucket(bucket); const list = b.objects.get(key) || [];
    if (!b.versioning) for (const old of list) this._free(old); // overwrite
    b.objects.set(key, b.versioning ? [...list, ver] : [ver]); return ver;
  }
  _free(ver) { for (const id of ver.stripes || []) { const st = this.stripes.get(id); if (!st) continue; for (const s of st.shards) this.node(s.node).del(id + "." + s.idx); this.stats.bytesStored -= st.shards.length * this.rs.shardSize(st.len); this.stripes.delete(id); } }
  putObject(bucket, key, body, { contentType = "application/octet-stream", meta = {} } = {}) {
    this.bucket(bucket); if (!key || key.length > 1024) throw new StoreError("InvalidKey", "keys are 1-1024 chars");
    const data = enc(body), stripes = this._stripeAll(data);
    this.stats.puts++; this.stats.bytesIn += data.length;
    const ver = { key, versionId: this.bucket(bucket).versioning ? vid() : "null", etag: md5(data), size: data.length, stripes, contentType, meta, modified: Date.now() };
    this.emit({ type: "put", bucket, key, size: data.length, stripes: stripes.length }); return this._commit(bucket, key, ver);
  }
  head(bucket, key, versionId) {
    const list = this.bucket(bucket).objects.get(key); if (!list?.length) throw new StoreError("NoSuchKey", `no key ${key}`, 404);
    const v = versionId ? list.find((x) => x.versionId === versionId) : list.at(-1);
    if (!v) throw new StoreError("NoSuchVersion", "no such version", 404); if (v.deleteMarker && !versionId) throw new StoreError("NoSuchKey", `no key ${key}`, 404);
    return v;
  }
  /** Get an object (optionally a byte range [start, end] inclusive). Degraded stripes are rebuilt on the fly. */
  getObject(bucket, key, { versionId, range, repair = true } = {}) {
    const v = this.head(bucket, key, versionId); this.stats.gets++;
    let [a, z] = range || [0, v.size - 1]; z = Math.min(z, v.size - 1); if (a > z && v.size) throw new StoreError("InvalidRange", "range not satisfiable", 416);
    const out = new Uint8Array(Math.max(0, z - a + 1)); let pos = 0, off = 0;
    for (const id of v.stripes) {
      const st = this.stripes.get(id), s0 = off, s1 = off + st.len - 1; off += st.len;
      if (s1 < a || s0 > z || !st.len) continue;
      const buf = this._readStripe(id, { repair }), from = Math.max(a, s0) - s0, to = Math.min(z, s1) - s0 + 1;
      out.set(buf.subarray(from, to), pos); pos += to - from;
    }
    return { body: out, ...v };
  }
  deleteObject(bucket, key, { versionId } = {}) {
    const b = this.bucket(bucket), list = b.objects.get(key) || [];
    if (versionId) { const i = list.findIndex((x) => x.versionId === versionId); if (i < 0) throw new StoreError("NoSuchVersion", "no such version", 404); this._free(list[i]); list.splice(i, 1); if (!list.length) b.objects.delete(key); return { versionId }; }
    if (b.versioning) { const dm = { key, versionId: vid(), deleteMarker: true, modified: Date.now(), size: 0 }; list.push(dm); b.objects.set(key, list); return { deleteMarker: true, versionId: dm.versionId }; }
    for (const v of list) this._free(v); b.objects.delete(key); return {};
  }
  versions(bucket, key) { return (this.bucket(bucket).objects.get(key) || []).map(({ versionId, etag, size, deleteMarker, modified }) => ({ versionId, etag, size, deleteMarker: !!deleteMarker, modified })).reverse(); }
  /** ListObjectsV2: prefix, delimiter (common prefixes), maxKeys, startAfter. */
  list(bucket, { prefix = "", delimiter = "", maxKeys = 1000, startAfter = "" } = {}) {
    const keys = [...this.bucket(bucket).objects.entries()].filter(([k, l]) => k.startsWith(prefix) && k > startAfter && !l.at(-1).deleteMarker).map(([k]) => k).sort();
    const contents = [], prefixes = new Set(); let truncated = false, last = "";
    for (const k of keys) {
      if (contents.length + prefixes.size >= maxKeys) { truncated = true; break; }
      if (delimiter) { const i = k.indexOf(delimiter, prefix.length); if (i >= 0) { prefixes.add(k.slice(0, i + delimiter.length)); last = k; continue; } }
      const v = this.bucket(bucket).objects.get(k).at(-1); contents.push({ key: k, size: v.size, etag: v.etag, modified: v.modified }); last = k;
    }
    return { contents, commonPrefixes: [...prefixes], truncated, nextStartAfter: truncated ? last : undefined };
  }
  // ---------- multipart ----------
  createMultipart(bucket, key, opts = {}) { this.bucket(bucket); const id = "mpu-" + vid(); this.uploads.set(id, { bucket, key, parts: new Map(), opts, started: Date.now() }); return id; }
  uploadPart(uploadId, partNumber, body) {
    const u = this.uploads.get(uploadId); if (!u) throw new StoreError("NoSuchUpload", "no upload " + uploadId, 404);
    if (!(partNumber >= 1 && partNumber <= 10000)) throw new StoreError("InvalidPart", "part numbers are 1-10000");
    const data = enc(body), old = u.parts.get(partNumber); if (old) this._free(old);
    const p = { stripes: this._stripeAll(data), size: data.length, etag: md5(data) }; u.parts.set(partNumber, p); this.stats.bytesIn += data.length; return p.etag;
  }
  /** parts: [{ partNumber, etag }] in ascending order. ETag = md5(concat(md5(part_i))) + "-" + n, like S3. */
  completeMultipart(uploadId, parts) {
    const u = this.uploads.get(uploadId); if (!u) throw new StoreError("NoSuchUpload", "no upload " + uploadId, 404);
    if (!parts.length) throw new StoreError("MalformedXML", "at least one part is required");
    let prev = 0;
    for (const { partNumber, etag } of parts) { const p = u.parts.get(partNumber); if (!p || p.etag !== String(etag).replace(/"/g, "")) throw new StoreError("InvalidPart", `part ${partNumber} missing or etag mismatch`); if (partNumber <= prev) throw new StoreError("InvalidPartOrder", "parts must be ascending"); prev = partNumber; }
    for (const [n, p] of u.parts) if (!parts.some((x) => x.partNumber === n)) this._free(p); // unused parts
    const chosen = parts.map((x) => u.parts.get(x.partNumber));
    const ver = { key: u.key, versionId: this.bucket(u.bucket).versioning ? vid() : "null", etag: hex(md5bytes(Uint8Array.from(chosen.flatMap((p) => [...hexToBytes(p.etag)])))) + "-" + parts.length, size: chosen.reduce((s, p) => s + p.size, 0), stripes: chosen.flatMap((p) => p.stripes), contentType: u.opts.contentType || "application/octet-stream", meta: u.opts.meta || {}, modified: Date.now() };
    this.uploads.delete(uploadId); this.stats.puts++; this.emit({ type: "put", bucket: u.bucket, key: u.key, size: ver.size, stripes: ver.stripes.length, multipart: parts.length });
    return this._commit(u.bucket, u.key, ver);
  }
  abortMultipart(uploadId) { const u = this.uploads.get(uploadId); if (!u) throw new StoreError("NoSuchUpload", "no upload", 404); for (const p of u.parts.values()) this._free(p); this.uploads.delete(uploadId); }
  // ---------- failure + healing ----------
  fail(id) { const n = this.node(id); n.up = false; this.emit({ type: "node-down", node: id }); }
  recover(id) { const n = this.node(id); n.up = true; this.emit({ type: "node-up", node: id }); }
  /** Permanently lose a node's disks (data wiped). */
  destroy(id) { const n = this.node(id); n.shards.clear(); n.bytes = 0; this.emit({ type: "node-wiped", node: id }); }
  /** Flip a random byte in one stored shard (silent bit rot). Returns {stripe, shard, node} */
  bitrot(rand = Math.random) {
    const ids = [...this.stripes.keys()]; if (!ids.length) return null; const st = this.stripes.get(ids[Math.floor(rand() * ids.length)]), s = st.shards[Math.floor(rand() * st.shards.length)];
    const buf = this.node(s.node).shards.get(st.id + "." + s.idx); if (!buf) return null; buf[Math.floor(rand() * buf.length)] ^= 1 + Math.floor(rand() * 255);
    return { stripe: st.id, shard: s.idx, node: s.node };
  }
  /** Health of every stripe: healthy / degraded (missing <= m) / lost. */
  health() {
    const r = { stripes: this.stripes.size, healthy: 0, degraded: 0, atRisk: 0, lost: 0, missingShards: 0 };
    for (const st of this.stripes.values()) {
      let ok = 0; for (const s of st.shards) { const n = this.node(s.node); if (n.up && n.shards.has(st.id + "." + s.idx)) ok++; }
      const miss = this.rs.n - ok; r.missingShards += miss;
      if (!miss) r.healthy++; else if (ok < this.k) r.lost++; else { r.degraded++; if (ok === this.k) r.atRisk++; }
    }
    return r;
  }
  /** Rebuild missing shards onto healthy nodes. Returns number of shards rebuilt. budget = max stripes. */
  repair(budget = Infinity) { let n = 0, done = 0; for (const st of this.stripes.values()) { if (done >= budget) break; const r = this._repairStripe(st); if (r > 0) { n += r; done++; } } return n; }
  /** Verify CRCs of every stored shard on up nodes, drop corrupt ones so repair() replaces them. */
  scrub() {
    let bad = 0;
    for (const st of this.stripes.values()) for (const s of st.shards) { const n = this.node(s.node); if (!n.up) continue; const b = n.shards.get(st.id + "." + s.idx); if (b && crc32(b) !== s.crc) { n.del(st.id + "." + s.idx); bad++; this.stats.corruptFound++; this.emit({ type: "corrupt", stripe: st.id, shard: s.idx, node: s.node }); } }
    return bad;
  }
  usage() { const raw = [...this.buckets.values()].reduce((s, b) => s + [...b.objects.values()].reduce((a, l) => a + l.reduce((x, v) => x + (v.size || 0), 0), 0), 0); const stored = this.nodes.reduce((s, n) => s + n.bytes, 0); return { raw, stored, overhead: raw ? stored / raw : this.rs.n / this.k }; }
}
const hexToBytes = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
