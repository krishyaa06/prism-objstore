// S3-compatible subset over HTTP (path-style): buckets, objects, Range, ListObjectsV2, versioning, multipart.
// Auth headers are accepted but not verified; put a real SigV4 verifier in front for production.
import http from "node:http";
import { ObjectStore, StoreError } from "../store.js";

const xmlEsc = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));
const X = (tag, body) => `<?xml version="1.0" encoding="UTF-8"?>\n<${tag} xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${body}</${tag}>`;
const iso = (t) => new Date(t).toISOString();
function readBody(req) { return new Promise((res, rej) => { const parts = []; req.on("data", (c) => parts.push(c)); req.on("end", () => res(new Uint8Array(Buffer.concat(parts)))); req.on("error", rej); }); }

export function createServer(store = new ObjectStore(), { log = () => {} } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x"), q = url.searchParams, [, bucket = "", ...rest] = url.pathname.split("/"), key = decodeURIComponent(rest.join("/"));
    const send = (status, body = "", headers = {}) => { res.writeHead(status, { "x-amz-request-id": Math.random().toString(36).slice(2, 14).toUpperCase(), server: "PrismObjstore", ...headers }); res.end(body); log(`${req.method} ${url.pathname}${url.search} -> ${status}`); };
    const xml = (status, body, h = {}) => send(status, body, { "content-type": "application/xml", ...h });
    try {
      if (req.method === "GET" && url.pathname === "/_admin/health") return send(200, JSON.stringify({ ...store.health(), usage: store.usage(), nodes: store.nodes.map((n) => ({ id: n.id, zone: n.zone, up: n.up, shards: n.shards.size, bytes: n.bytes })) }, null, 2), { "content-type": "application/json" });
      if (req.method === "POST" && url.pathname.startsWith("/_admin/")) {
        const [, , action, id] = url.pathname.split("/"); let out = {};
        if (action === "fail") store.fail(id); else if (action === "recover") store.recover(id); else if (action === "repair") out = { rebuilt: store.repair() }; else if (action === "scrub") out = { corrupt: store.scrub() }; else throw new StoreError("NotImplemented", "unknown admin action", 501);
        return send(200, JSON.stringify({ ok: true, ...out, health: store.health() }), { "content-type": "application/json" });
      }
      if (!bucket) { // ListBuckets
        if (req.method !== "GET") throw new StoreError("MethodNotAllowed", "", 405);
        return xml(200, X("ListAllMyBucketsResult", `<Owner><ID>prism</ID><DisplayName>prism</DisplayName></Owner><Buckets>${[...store.buckets.values()].map((b) => `<Bucket><Name>${xmlEsc(b.name)}</Name><CreationDate>${iso(b.created)}</CreationDate></Bucket>`).join("")}</Buckets>`));
      }
      if (!key) {
        if (req.method === "PUT" && q.has("versioning")) { const body = new TextDecoder().decode(await readBody(req)); store.setVersioning(bucket, /<Status>Enabled<\/Status>/.test(body)); return send(200); }
        if (req.method === "PUT") { store.createBucket(bucket); return send(200, "", { location: "/" + bucket }); }
        if (req.method === "DELETE") { store.deleteBucket(bucket); return send(204); }
        if (req.method === "HEAD") { store.bucket(bucket); return send(200); }
        if (req.method === "GET" && q.has("versioning")) return xml(200, X("VersioningConfiguration", store.bucket(bucket).versioning ? "<Status>Enabled</Status>" : ""));
        if (req.method === "GET") {
          const r = store.list(bucket, { prefix: q.get("prefix") || "", delimiter: q.get("delimiter") || "", maxKeys: +(q.get("max-keys") || 1000), startAfter: q.get("continuation-token") || q.get("start-after") || "" });
          return xml(200, X("ListBucketResult", `<Name>${xmlEsc(bucket)}</Name><Prefix>${xmlEsc(q.get("prefix") || "")}</Prefix><KeyCount>${r.contents.length + r.commonPrefixes.length}</KeyCount><MaxKeys>${q.get("max-keys") || 1000}</MaxKeys><IsTruncated>${r.truncated}</IsTruncated>${r.truncated ? `<NextContinuationToken>${xmlEsc(r.nextStartAfter)}</NextContinuationToken>` : ""}${r.contents.map((c) => `<Contents><Key>${xmlEsc(c.key)}</Key><LastModified>${iso(c.modified)}</LastModified><ETag>"${c.etag}"</ETag><Size>${c.size}</Size><StorageClass>STANDARD</StorageClass></Contents>`).join("")}${r.commonPrefixes.map((p) => `<CommonPrefixes><Prefix>${xmlEsc(p)}</Prefix></CommonPrefixes>`).join("")}`));
        }
        throw new StoreError("MethodNotAllowed", "", 405);
      }
      // multipart
      if (req.method === "POST" && q.has("uploads")) { const id = store.createMultipart(bucket, key, { contentType: req.headers["content-type"] }); return xml(200, X("InitiateMultipartUploadResult", `<Bucket>${xmlEsc(bucket)}</Bucket><Key>${xmlEsc(key)}</Key><UploadId>${id}</UploadId>`)); }
      if (req.method === "PUT" && q.has("uploadId")) { const etag = store.uploadPart(q.get("uploadId"), +q.get("partNumber"), await readBody(req)); return send(200, "", { etag: `"${etag}"` }); }
      if (req.method === "POST" && q.has("uploadId")) {
        const body = new TextDecoder().decode(await readBody(req)), parts = [...body.matchAll(/<Part>\s*<PartNumber>(\d+)<\/PartNumber>\s*<ETag>([^<]+)<\/ETag>\s*<\/Part>|<Part>\s*<ETag>([^<]+)<\/ETag>\s*<PartNumber>(\d+)<\/PartNumber>\s*<\/Part>/g)].map((m) => ({ partNumber: +(m[1] || m[4]), etag: (m[2] || m[3]).replace(/&quot;|"/g, "") }));
        const v = store.completeMultipart(q.get("uploadId"), parts);
        return xml(200, X("CompleteMultipartUploadResult", `<Location>/${xmlEsc(bucket)}/${xmlEsc(key)}</Location><Bucket>${xmlEsc(bucket)}</Bucket><Key>${xmlEsc(key)}</Key><ETag>"${v.etag}"</ETag>`));
      }
      if (req.method === "DELETE" && q.has("uploadId")) { store.abortMultipart(q.get("uploadId")); return send(204); }
      if (req.method === "PUT") {
        const meta = Object.fromEntries(Object.entries(req.headers).filter(([k]) => k.startsWith("x-amz-meta-")).map(([k, v]) => [k.slice(11), v]));
        const v = store.putObject(bucket, key, await readBody(req), { contentType: req.headers["content-type"], meta });
        return send(200, "", { etag: `"${v.etag}"`, ...(v.versionId !== "null" ? { "x-amz-version-id": v.versionId } : {}) });
      }
      if (req.method === "DELETE") { const r = store.deleteObject(bucket, key, { versionId: q.get("versionId") || undefined }); return send(204, "", { ...(r.deleteMarker ? { "x-amz-delete-marker": "true" } : {}), ...(r.versionId ? { "x-amz-version-id": r.versionId } : {}) }); }
      if (req.method === "GET" || req.method === "HEAD") {
        const versionId = q.get("versionId") || undefined, v = store.head(bucket, key, versionId);
        const headers = { etag: `"${v.etag}"`, "last-modified": new Date(v.modified).toUTCString(), "content-type": v.contentType || "application/octet-stream", "accept-ranges": "bytes", ...Object.fromEntries(Object.entries(v.meta || {}).map(([k, x]) => ["x-amz-meta-" + k, x])), ...(v.versionId !== "null" ? { "x-amz-version-id": v.versionId } : {}) };
        if (req.method === "HEAD") return send(200, "", { ...headers, "content-length": v.size });
        const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || ""); let range;
        if (m) { range = m[1] === "" ? [Math.max(0, v.size - +m[2]), v.size - 1] : [+m[1], m[2] === "" ? v.size - 1 : +m[2]]; }
        const r = store.getObject(bucket, key, { versionId, range });
        return send(range ? 206 : 200, Buffer.from(r.body), { ...headers, "content-length": r.body.length, ...(range ? { "content-range": `bytes ${range[0]}-${Math.min(range[1], v.size - 1)}/${v.size}` } : {}) });
      }
      throw new StoreError("MethodNotAllowed", "method not allowed", 405);
    } catch (e) {
      const status = e.status || 500, code = e.code || "InternalError";
      xml(status, X("Error", `<Code>${code}</Code><Message>${xmlEsc(e.message)}</Message><Resource>${xmlEsc(url.pathname)}</Resource>`));
    }
  });
  return server;
}
