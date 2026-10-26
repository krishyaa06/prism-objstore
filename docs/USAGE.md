# Prism Objstore — Usage

## Install

```bash
npm install github:krishyaa06/prism-objstore
# or run the CLI directly
npx github:krishyaa06/prism-objstore --help
```

## JavaScript API

```js
import { ObjectStore, ReedSolomon, durability } from "prism-objstore";

const s3 = new ObjectStore({ k: 6, m: 3, nodes: 12, zones: 3 });
s3.createBucket("photos", { versioning: true });
s3.putObject("photos", "2026/cat.jpg", bytes, { contentType: "image/jpeg" });

for (const n of s3.nodes.filter((n) => n.zone === "zone-a")) s3.fail(n.id);   // lose a zone
const { body, etag } = s3.getObject("photos", "2026/cat.jpg");              // degraded read, still correct
s3.repair();                                                                 // rebuild missing shards
s3.scrub();                                                                  // find bit rot via CRC-32

// raw codec
const rs = new ReedSolomon(10, 4);
const shards = rs.encode(data);      // 14 shards
shards[2] = shards[7] = null;        // lose any 4
rs.reconstruct(shards); rs.join(shards, data.length);

durability({ k: 6, m: 3, afr: 0.02, repairHours: 6 });   // { overhead: 1.5, nines: 14.2 }
```

| Export | What it does |
|---|---|
| `new ObjectStore({ k, m, nodes, zones, stripeSize })` | Erasure-coded store over in-memory nodes |
| `createBucket(name, { versioning })` · `deleteBucket` · `setVersioning` | Buckets |
| `putObject(b, key, body, { contentType, meta })` · `getObject(b, key, { versionId, range, repair })` · `head` · `deleteObject` · `versions` · `list(b, { prefix, delimiter, maxKeys, startAfter })` | Objects |
| `createMultipart` · `uploadPart(id, n, body)` · `completeMultipart(id, parts)` · `abortMultipart` | Multipart uploads |
| `fail(node)` · `recover(node)` · `destroy(node)` · `bitrot()` · `health()` · `repair(budget)` · `scrub()` · `usage()` | Failure and healing |
| `new ReedSolomon(k, m)` · `.encode(data)` · `.reconstruct(shards)` · `.join(shards, len)` · `.verify(shards)` | Codec |
| `durability({ k, m, afr, repairHours })` · `gf` · `crc32` · `md5` | Math and checksums |
| `createServer(store)` from `src/node/server.js` | S3-compatible HTTP server |

## CLI

```bash
$ npx github:krishyaa06/prism-objstore demo
$ npx github:krishyaa06/prism-objstore encode photo.jpg --k 10 --m 4
$ npx github:krishyaa06/prism-objstore durability --afr 0.03 --repair 12
$ npx github:krishyaa06/prism-objstore serve --port 9000
$ curl -X PUT localhost:9000/photos && curl -T cat.jpg localhost:9000/photos/cat.jpg
$ curl -X POST localhost:9000/_admin/fail/node-01 && curl -r 0-99 localhost:9000/photos/cat.jpg
```

| Command | Description |
|---|---|
| `objstore serve [--port 9000] [--k --m --nodes --zones]` | Start the S3-compatible API with `/_admin/{fail,recover,repair,scrub,health}` |
| `objstore encode <file> [--k --m]` | Show shards, drop m at random, rebuild and verify MD5 |
| `objstore demo [--k --m]` | Zone outage, degraded reads, repair, bit rot and scrub |
| `objstore durability [--afr --repair]` | Compare layouts with 3× replication |
| `objstore bench [--mb --k --m]` | Encode and rebuild throughput |

## Live simulator

Open [https://krishyaa06.github.io/prism-objstore/](https://krishyaa06.github.io/prism-objstore/) or serve the repo root locally (`npx serve .`). The simulator imports the same modules from `src/`.
