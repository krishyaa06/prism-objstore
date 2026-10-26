// Systematic Reed–Solomon erasure code over GF(256): k data shards + m parity shards.
// Parity rows form a Cauchy matrix, so ANY k of the k+m shards reconstruct the data.
import { mulAdd, invert, inv } from "./gf256.js";
export class ReedSolomon {
  constructor(k, m) {
    if (!(k >= 1 && m >= 0 && k + m <= 256)) throw new RangeError("need 1 <= k and k + m <= 256");
    this.k = k; this.m = m; this.n = k + m;
    this.parity = Array.from({ length: m }, (_, i) => Uint8Array.from({ length: k }, (_, j) => inv((i + k) ^ j))); // 1/(x_i + y_j)
    this.matrix = [...Array.from({ length: k }, (_, i) => { const r = new Uint8Array(k); r[i] = 1; return r; }), ...this.parity];
    this._invCache = new Map();
  }
  shardSize(len) { return Math.max(1, Math.ceil(len / this.k)); }
  /** Split + encode. Returns k+m Uint8Array shards of equal size (last data shard zero-padded). */
  encode(data) {
    const size = this.shardSize(data.length), shards = Array.from({ length: this.n }, () => new Uint8Array(size));
    for (let i = 0; i < this.k; i++) shards[i].set(data.subarray(i * size, Math.min(data.length, (i + 1) * size)));
    this.encodeParity(shards); return shards;
  }
  encodeParity(shards) { for (let i = 0; i < this.m; i++) { const p = shards[this.k + i]; p.fill(0); for (let j = 0; j < this.k; j++) mulAdd(p, shards[j], this.parity[i][j]); } return shards; }
  /** Rebuild missing shards in place (null/undefined entries). Throws if fewer than k shards survive. */
  reconstruct(shards) {
    const have = []; for (let i = 0; i < this.n; i++) if (shards[i]) have.push(i);
    if (have.length < this.k) throw new Error(`unrecoverable: ${have.length} of ${this.n} shards available, need ${this.k}`);
    const missingData = []; for (let i = 0; i < this.k; i++) if (!shards[i]) missingData.push(i);
    const size = shards[have[0]].length;
    if (missingData.length) {
      const use = have.slice(0, this.k), key = use.join(","); let D = this._invCache.get(key);
      if (!D) { D = invert(use.map((i) => this.matrix[i])); this._invCache.set(key, D); if (this._invCache.size > 256) this._invCache.delete(this._invCache.keys().next().value); }
      for (const d of missingData) { const out = new Uint8Array(size); for (let t = 0; t < this.k; t++) mulAdd(out, shards[use[t]], D[d][t]); shards[d] = out; }
    }
    for (let i = 0; i < this.m; i++) if (!shards[this.k + i]) { const p = new Uint8Array(size); for (let j = 0; j < this.k; j++) mulAdd(p, shards[j], this.parity[i][j]); shards[this.k + i] = p; }
    return shards;
  }
  /** Join data shards back to the original length. */
  join(shards, length) { const out = new Uint8Array(length), size = shards[0].length; for (let i = 0; i < this.k && i * size < length; i++) out.set(shards[i].subarray(0, Math.min(size, length - i * size)), i * size); return out; }
  /** True if parity matches data. */
  verify(shards) { const copy = shards.map((s) => s.slice()); this.encodeParity(copy); return copy.every((s, i) => s.every((b, j) => b === shards[i][j])); }
}
/** Simplified durability model: independent shard failures, Poisson AFR, fixed repair window. */
export function durability({ k, m, afr = 0.02, repairHours = 6 }) {
  const n = k + m, p = 1 - Math.exp(-afr * repairHours / 8760);
  const C = (a, b) => { let r = 1; for (let i = 1; i <= b; i++) r = (r * (a - b + i)) / i; return r; };
  let loss = 0; for (let f = m + 1; f <= n; f++) loss += C(n, f) * p ** f * (1 - p) ** (n - f);
  const windows = 8760 / repairHours, year = -Math.expm1(windows * Math.log1p(-loss));
  return { overhead: n / k, perWindow: loss, annualLoss: year, nines: year > 0 ? -Math.log10(year) : Infinity };
}
