// GF(2^8) arithmetic (primitive polynomial x^8+x^4+x^3+x^2+1 = 0x11d) + matrix helpers.
export const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
{ let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; }
/** Full 256x256 multiplication table: MUL[a << 8 | b] = a·b */
export const MUL = new Uint8Array(65536);
for (let a = 1; a < 256; a++) for (let b = 1; b < 256; b++) MUL[(a << 8) | b] = EXP[LOG[a] + LOG[b]];
export const add = (a, b) => a ^ b;
export const mul = (a, b) => MUL[(a << 8) | b];
export const div = (a, b) => { if (!b) throw new RangeError("division by zero in GF(256)"); return a ? EXP[(LOG[a] + 255 - LOG[b]) % 255] : 0; };
export const inv = (a) => div(1, a);
/** dst ^= c · src (the inner loop of encoding and decoding) */
export function mulAdd(dst, src, c) { if (!c) return; if (c === 1) { for (let i = 0; i < dst.length; i++) dst[i] ^= src[i]; return; } const r = c << 8; for (let i = 0; i < dst.length; i++) dst[i] ^= MUL[r | src[i]]; }
/** Invert a square matrix (array of Uint8Array rows) by Gauss–Jordan elimination. */
export function invert(M) {
  const n = M.length, A = M.map((r, i) => { const row = new Uint8Array(2 * n); row.set(r); row[n + i] = 1; return row; });
  for (let c = 0; c < n; c++) {
    let p = c; while (p < n && !A[p][c]) p++; if (p === n) throw new Error("matrix is singular");
    [A[c], A[p]] = [A[p], A[c]];
    const ic = inv(A[c][c]); for (let j = 0; j < 2 * n; j++) A[c][j] = mul(A[c][j], ic);
    for (let r = 0; r < n; r++) if (r !== c && A[r][c]) { const f = A[r][c]; for (let j = 0; j < 2 * n; j++) A[r][j] ^= mul(f, A[c][j]); }
  }
  return A.map((r) => r.slice(n));
}
