// PDF password protection: open protected files (RC4 40/128, AES-128, AES-256) and protect with AES-256.
// pdf-lib cannot read or write encrypted files, so this implements the standard security handler
// (ISO 32000-2, algorithms 2, 2.A, 2.B, 4-9) on top of pdf-lib's own object model.
import forge from 'node-forge';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFObject, PDFObjectStreamParser, PDFParser, PDFRawStream, PDFRef, PDFStream, PDFString } from 'pdf-lib';

const PAD = Uint8Array.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

export class WrongPasswordError extends Error {
  constructor(public needed: boolean) {
    super(needed ? 'This PDF needs a password.' : 'That password is not right.');
    this.name = 'WrongPasswordError';
  }
}

// ---------- byte helpers ----------
const bin = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
  return s;
};
const unbin = (s: string) => {
  const o = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) o[i] = s.charCodeAt(i) & 255;
  return o;
};
const cat = (...p: Uint8Array[]) => {
  const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let k = 0;
  for (const x of p) (o.set(x, k), (k += x.length));
  return o;
};
const md5 = (b: Uint8Array) => unbin(forge.md.md5.create().update(bin(b)).digest().getBytes());
const sha = (alg: 256 | 384 | 512, b: Uint8Array) => unbin((forge.md as any)['sha' + alg].create().update(bin(b)).digest().getBytes());
const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const rand = (n: number) => unbin(forge.random.getBytesSync(n));
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const u32le = (n: number) => Uint8Array.from([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);

function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = new Uint8Array(data.length);
  for (let n = 0, i = 0, j = 0; n < data.length; n++) {
    i = (i + 1) & 255;
    j = (j + s[i]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
    out[n] = data[n] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}

/** AES-CBC. `pad` = PKCS#7 handled by us; raw = no padding at all (key wrapping, algorithm 2.B). */
function aesCbc(key: Uint8Array, iv: Uint8Array, data: Uint8Array, encrypt: boolean, pad: boolean): Uint8Array {
  const c = encrypt ? forge.cipher.createCipher('AES-CBC', bin(key)) : forge.cipher.createDecipher('AES-CBC', bin(key));
  c.start({ iv: bin(iv) });
  c.update(forge.util.createBuffer(bin(data)));
  (c.finish as (p?: () => boolean) => boolean)(pad ? undefined : () => true);
  return unbin(c.output.getBytes());
}
function aesDecryptData(key: Uint8Array, data: Uint8Array): Uint8Array {
  if (data.length < 32) return new Uint8Array(0);
  const body = data.subarray(16, data.length - ((data.length - 16) % 16));
  const out = aesCbc(key, data.subarray(0, 16), body, false, false);
  const p = out[out.length - 1];
  return p >= 1 && p <= 16 ? out.subarray(0, out.length - p) : out;
}
function aesEncryptData(key: Uint8Array, data: Uint8Array): Uint8Array {
  const iv = rand(16);
  const padN = 16 - (data.length % 16);
  const padded = cat(data, new Uint8Array(padN).fill(padN));
  return cat(iv, aesCbc(key, iv, padded, true, false));
}

// ---------- Algorithm 2.B (revision 6 hash) ----------
function hashR56(r: number, pw: Uint8Array, salt: Uint8Array, udata: Uint8Array): Uint8Array {
  let k = sha(256, cat(pw, salt, udata));
  if (r < 6) return k;
  let e: Uint8Array = new Uint8Array(0);
  for (let i = 0; i < 64 || e[e.length - 1] > i - 32; i++) {
    const k1 = cat(pw, k, udata);
    const rep = new Uint8Array(k1.length * 64);
    for (let j = 0; j < 64; j++) rep.set(k1, j * k1.length);
    e = aesCbc(k.subarray(0, 16), k.subarray(16, 32), rep, true, false);
    let mod = 0;
    for (let j = 0; j < 16; j++) mod += e[j];
    mod %= 3;
    k = sha(mod === 0 ? 256 : mod === 1 ? 384 : 512, e);
  }
  return k.subarray(0, 32);
}
const pwBytes5 = (pw: string) => new TextEncoder().encode(pw.normalize('NFKC')).subarray(0, 127);
const pwBytes4 = (pw: string) => {
  // Latin-1 / PDFDocEncoding, 32 bytes max, padded
  const raw = Uint8Array.from([...pw].map((c) => (c.charCodeAt(0) < 256 ? c.charCodeAt(0) : 63)));
  return cat(raw, PAD).subarray(0, 32);
};

// ---------- the encryption dictionary ----------
export interface CryptInfo {
  v: number;
  r: number;
  keyLen: number; // bytes
  o: Uint8Array;
  u: Uint8Array;
  oe?: Uint8Array;
  ue?: Uint8Array;
  p: number;
  id0: Uint8Array;
  encryptMetadata: boolean;
  stm: 'none' | 'rc4' | 'aes128' | 'aes256';
  str: 'none' | 'rc4' | 'aes128' | 'aes256';
}

const strBytes = (o: PDFObject | undefined): Uint8Array => {
  if (o instanceof PDFHexString || o instanceof PDFString) return o.asBytes();
  return new Uint8Array(0);
};

function readCrypt(enc: PDFDict, ctx: { lookup: (o: any) => any }, id0: Uint8Array): CryptInfo {
  const num = (k: string, d = 0) => {
    const v = ctx.lookup(enc.get(PDFName.of(k)));
    return v instanceof PDFNumber ? v.asNumber() : d;
  };
  const v = num('V');
  const r = num('R');
  const filter = ctx.lookup(enc.get(PDFName.of('Filter')));
  if (!(filter instanceof PDFName) || filter.asString() !== '/Standard') throw new Error('This PDF uses a security method PweDeF does not support.');
  if (v === 3 || v > 5 || r > 6) throw new Error('This PDF uses an unsupported encryption version.');
  let stm: CryptInfo['stm'] = 'rc4';
  let str: CryptInfo['str'] = 'rc4';
  let keyLen = v === 1 ? 5 : Math.max(5, Math.min(16, num('Length', 40) / 8));
  if (v >= 4) {
    const cf = ctx.lookup(enc.get(PDFName.of('CF')));
    const method = (nameKey: string): CryptInfo['stm'] => {
      const n = ctx.lookup(enc.get(PDFName.of(nameKey)));
      const name = n instanceof PDFName ? n.decodeText() : 'Identity';
      if (name === 'Identity' || !(cf instanceof PDFDict)) return 'none';
      const f = ctx.lookup(cf.get(PDFName.of(name)));
      const m = f instanceof PDFDict ? ctx.lookup(f.get(PDFName.of('CFM'))) : null;
      const cfm = m instanceof PDFName ? m.decodeText() : 'None';
      return cfm === 'V2' ? 'rc4' : cfm === 'AESV2' ? 'aes128' : cfm === 'AESV3' ? 'aes256' : 'none';
    };
    stm = method('StmF');
    str = method('StrF');
    keyLen = v === 5 ? 32 : 16;
  }
  const em = ctx.lookup(enc.get(PDFName.of('EncryptMetadata')));
  return {
    v, r, keyLen,
    o: strBytes(ctx.lookup(enc.get(PDFName.of('O')))),
    u: strBytes(ctx.lookup(enc.get(PDFName.of('U')))),
    oe: strBytes(ctx.lookup(enc.get(PDFName.of('OE')))),
    ue: strBytes(ctx.lookup(enc.get(PDFName.of('UE')))),
    p: num('P') | 0,
    id0,
    encryptMetadata: !(em && (em as any).asBoolean?.() === false),
    stm, str,
  };
}

/** The file key when `password` is the user or owner password, otherwise null. */
function fileKey(c: CryptInfo, password: string): Uint8Array | null {
  if (c.r >= 5) {
    const pw = pwBytes5(password);
    const u48 = c.u.subarray(0, 48);
    // user
    if (eq(hashR56(c.r, pw, u48.subarray(32, 40), new Uint8Array(0)), u48.subarray(0, 32)))
      return aesCbc(hashR56(c.r, pw, u48.subarray(40, 48), new Uint8Array(0)), new Uint8Array(16), c.ue!.subarray(0, 32), false, false);
    // owner
    const o48 = c.o.subarray(0, 48);
    if (eq(hashR56(c.r, pw, o48.subarray(32, 40), u48), o48.subarray(0, 32)))
      return aesCbc(hashR56(c.r, pw, o48.subarray(40, 48), u48), new Uint8Array(16), c.oe!.subarray(0, 32), false, false);
    return null;
  }
  const n = c.r === 2 ? 5 : c.keyLen;
  const tryUser = (padded: Uint8Array): Uint8Array | null => {
    let h = md5(cat(padded, c.o.subarray(0, 32), u32le(c.p), c.id0, c.r >= 4 && !c.encryptMetadata ? new Uint8Array(4).fill(255) : new Uint8Array(0)));
    if (c.r >= 3) for (let i = 0; i < 50; i++) h = md5(h.subarray(0, n));
    const key = h.subarray(0, n);
    let ok: boolean;
    if (c.r === 2) ok = eq(rc4(key, PAD), c.u.subarray(0, 32));
    else {
      let x = rc4(key, md5(cat(PAD, c.id0)));
      for (let i = 1; i <= 19; i++) x = rc4(key.map((b) => b ^ i), x);
      ok = eq(x, c.u.subarray(0, 16));
    }
    return ok ? key : null;
  };
  const padded = pwBytes4(password);
  const asUser = tryUser(padded);
  if (asUser) return asUser;
  // owner password: recover the user password from /O (algorithm 7)
  let h = md5(padded);
  if (c.r >= 3) for (let i = 0; i < 50; i++) h = md5(h);
  const ok = h.subarray(0, n);
  let up = c.o.subarray(0, 32);
  if (c.r === 2) up = rc4(ok, up);
  else for (let i = 19; i >= 0; i--) up = rc4(ok.map((b) => b ^ i), up);
  return tryUser(up);
}

const objKey = (c: CryptInfo, base: Uint8Array, ref: PDFRef, aes: boolean) => {
  if (c.r >= 5) return base;
  const n = ref.objectNumber;
  const g = ref.generationNumber;
  const salt = aes ? Uint8Array.from([0x73, 0x41, 0x6c, 0x54]) : new Uint8Array(0);
  const h = md5(cat(base, Uint8Array.from([n & 255, (n >> 8) & 255, (n >> 16) & 255, g & 255, (g >> 8) & 255]), salt));
  return h.subarray(0, Math.min(base.length + 5, 16));
};
const decryptWith = (m: CryptInfo['stm'], c: CryptInfo, base: Uint8Array, ref: PDFRef, data: Uint8Array) => {
  if (m === 'none') return data;
  const key = objKey(c, base, ref, m !== 'rc4');
  return m === 'rc4' ? rc4(key, data) : aesDecryptData(key, data);
};

// ---------- reading ----------
const ENDOBJ = [...'endobj'].map((c) => c.charCodeAt(0));
type ParserCtor = new (bytes: Uint8Array, perTick?: number, strict?: boolean, cap?: boolean) => any;

/** Files with cross-reference streams keep /Root, /Encrypt, /ID and /Info in the stream's dictionary, not in a trailer. */
function takeTrailer(ctx: any, dict: PDFDict) {
  for (const k of ['Root', 'Encrypt', 'Info', 'ID']) {
    const v = dict.get(PDFName.of(k));
    if (v) ctx.trailerInfo[k] = v;
  }
}

/** Pass 1: parse without expanding object streams, only to find /Encrypt and /ID. */
class RawParser extends (PDFParser as unknown as ParserCtor) {
  async parseIndirectObject() {
    const ref = this.parseIndirectObjectHeader();
    this.skipWhitespaceAndComments();
    const object = this.parseObject();
    this.skipWhitespaceAndComments();
    this.matchKeyword(ENDOBJ);
    if (object instanceof PDFRawStream && object.dict.get(PDFName.of('Type')) === PDFName.of('XRef')) takeTrailer(this.context, object.dict);
    this.context.assign(ref, object);
    return ref;
  }
}

/** The trailer entries of a file (for tests). */
export async function trailerOf(bytes: Uint8Array) {
  return (await parseWith(RawParser, bytes)).trailerInfo as { Root?: PDFObject; Encrypt?: PDFObject; Info?: PDFObject; ID?: PDFObject };
}

export interface Prepared {
  info: CryptInfo;
  key: Uint8Array;
}

async function parseWith(P: ParserCtor, bytes: Uint8Array) {
  const parser = new P(bytes, Infinity, false, false);
  return parser.parseDocument();
}

/** True when the file has an /Encrypt entry. Cheap enough to call on open. */
export async function isEncrypted(bytes: Uint8Array): Promise<boolean> {
  // /Encrypt sits in plain text in the trailer, so most files can be ruled out without parsing them.
  const key = [...'/Encrypt'].map((c) => c.charCodeAt(0));
  let seen = false;
  for (let i = 0, end = bytes.length - key.length; i <= end && !seen; i++) {
    if (bytes[i] !== 47) continue;
    let k = 1;
    while (k < key.length && bytes[i + k] === key[k]) k++;
    seen = k === key.length;
  }
  if (!seen) return false;
  try {
    await PDFDocument.load(bytes, { updateMetadata: false });
    return false;
  } catch (e: any) {
    return /encrypt/i.test(String(e?.message)) || e?.name === 'EncryptedPDFError';
  }
}

/** Opens a protected PDF and returns a plain copy. Throws WrongPasswordError. */
export async function decryptPdf(bytes: Uint8Array, password: string): Promise<{ bytes: Uint8Array; protection: Protection }> {
  const raw = await parseWith(RawParser, bytes);
  const trailer = raw.trailerInfo;
  const encDict = raw.lookup(trailer.Encrypt);
  if (!(encDict instanceof PDFDict)) throw new Error('This PDF is marked as protected but its security settings are missing.');
  const idArr = raw.lookup(trailer.ID);
  const id0 = idArr instanceof PDFArray ? strBytes(raw.lookup(idArr.get(0))) : new Uint8Array(0);
  const info = readCrypt(encDict, raw, id0);
  const key = fileKey(info, password);
  if (!key) throw new WrongPasswordError(password === '');
  const encRef = trailer.Encrypt instanceof PDFRef ? trailer.Encrypt : null;

  class Decrypting extends (PDFParser as unknown as ParserCtor) {
    async parseIndirectObject() {
      const ref: PDFRef = this.parseIndirectObjectHeader();
      this.skipWhitespaceAndComments();
      let object: PDFObject = this.parseObject();
      this.skipWhitespaceAndComments();
      this.matchKeyword(ENDOBJ);
      const isEnc = encRef && ref.objectNumber === encRef.objectNumber;
      const type = object instanceof PDFRawStream ? object.dict.get(PDFName.of('Type')) : null;
      if (!isEnc && !(type === PDFName.of('XRef'))) {
        if (object instanceof PDFRawStream) {
          const stmType = type === PDFName.of('Metadata') && !info.encryptMetadata;
          const filt = object.dict.lookup(PDFName.of('Filter'));
          const crypt = (filt instanceof PDFName && filt.decodeText() === 'Crypt') || (filt instanceof PDFArray && filt.size() > 0 && filt.lookup(0) === PDFName.of('Crypt'));
          if (!stmType && !crypt) {
            const plain = decryptWith(info.stm, info, key!, ref, object.contents);
            object.dict.set(PDFName.of('Length'), PDFNumber.of(plain.length));
            object = PDFRawStream.of(object.dict, plain);
          }
        }
        this.decryptStrings(object, ref);
      }
      if (object instanceof PDFRawStream && type === PDFName.of('ObjStm')) {
        await (PDFObjectStreamParser as any).forStream(object, this.shouldWaitForTick).parseIntoContext();
        return ref;
      }
      if (type === PDFName.of('XRef')) {
        takeTrailer(this.context, (object as PDFRawStream).dict);
        return ref;
      }
      this.context.assign(ref, object);
      return ref;
    }
    decryptStrings(o: PDFObject, ref: PDFRef) {
      const dict = o instanceof PDFRawStream ? o.dict : o;
      const fix = (v: PDFObject | undefined): PDFObject | undefined => {
        if (v instanceof PDFString || v instanceof PDFHexString) return PDFHexString.of(hex(decryptWith(info.str, info, key!, ref, v.asBytes())));
        if (v instanceof PDFDict || v instanceof PDFArray) (this.decryptStrings(v, ref), undefined);
        return undefined;
      };
      if (dict instanceof PDFDict) for (const [k, v] of dict.entries()) {
        const n = fix(v);
        if (n) dict.set(k, n);
      }
      else if (dict instanceof PDFArray) for (let i = 0; i < dict.size(); i++) {
        const n = fix(dict.get(i));
        if (n) dict.set(i, n);
      }
    }
  }
  const ctx = await parseWith(Decrypting, bytes);
  ctx.trailerInfo.Encrypt = undefined;
  if (encRef) ctx.delete(encRef);
  const doc = new (PDFDocument as any)(ctx, true, false) as PDFDocument;
  const out = await doc.save({ useObjectStreams: true });
  return { bytes: out, protection: { userPassword: password, ownerPassword: password, permissions: decodePerms(info.p), strength: info.r >= 5 ? 'aes256' : info.stm === 'aes128' ? 'aes128' : 'rc4' } };
}

// ---------- writing (AES-256, revision 6) ----------
export interface Permissions {
  print: boolean;
  printHighQuality: boolean;
  edit: boolean;
  copy: boolean;
  annotate: boolean;
  fillForms: boolean;
  assemble: boolean;
}
export const ALL_PERMISSIONS: Permissions = { print: true, printHighQuality: true, edit: true, copy: true, annotate: true, fillForms: true, assemble: true };
export interface Protection {
  userPassword: string;
  ownerPassword: string;
  permissions: Permissions;
  strength?: 'aes256' | 'aes128' | 'rc4';
}

function encodePerms(p: Permissions): number {
  let n = 0xfffff0c0;
  if (p.print) n |= 4;
  if (p.edit) n |= 8;
  if (p.copy) n |= 16;
  if (p.annotate) n |= 32;
  if (p.fillForms) n |= 256;
  n |= 512; // accessibility readers may always extract
  if (p.assemble) n |= 1024;
  if (p.printHighQuality && p.print) n |= 2048;
  return n | 0;
}
function decodePerms(n: number): Permissions {
  return { print: !!(n & 4), edit: !!(n & 8), copy: !!(n & 16), annotate: !!(n & 32), fillForms: !!(n & 256), assemble: !!(n & 1024), printHighQuality: !!(n & 2048) };
}

/** Protects with AES-256. A blank user password means anyone can open it but the permissions are enforced. */
export async function encryptPdf(bytes: Uint8Array, prot: Protection): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = doc.context;
  const owner = prot.ownerPassword || prot.userPassword || bin(rand(8));
  const fk = rand(32);
  const P = encodePerms(prot.permissions);
  const upw = pwBytes5(prot.userPassword);
  const opw = pwBytes5(owner);

  const uVal = rand(8), uKey = rand(8);
  const U = cat(hashR56(6, upw, uVal, new Uint8Array(0)), uVal, uKey);
  const UE = aesCbc(hashR56(6, upw, uKey, new Uint8Array(0)), new Uint8Array(16), fk, true, false);
  const oVal = rand(8), oKey = rand(8);
  const O = cat(hashR56(6, opw, oVal, U), oVal, oKey);
  const OE = aesCbc(hashR56(6, opw, oKey, U), new Uint8Array(16), fk, true, false);
  const permBlock = cat(u32le(P), new Uint8Array(4).fill(255), Uint8Array.from([0x54]), Uint8Array.from([0x61, 0x64, 0x62]), rand(4));
  const Perms = aesCbc(fk, new Uint8Array(16), permBlock, true, false); // single block: ECB == CBC with zero IV

  // encrypt every string and stream
  const encStrings = (o: PDFObject): void => {
    const dict = o instanceof PDFStream ? o.dict : o;
    const fix = (v: PDFObject | undefined) => {
      if (v instanceof PDFString || v instanceof PDFHexString) return PDFHexString.of(hex(aesEncryptData(fk, v.asBytes())));
      if (v instanceof PDFDict || v instanceof PDFArray) encStrings(v);
      return undefined;
    };
    if (dict instanceof PDFDict) for (const [k, v] of dict.entries()) {
      const n = fix(v);
      if (n) dict.set(k, n);
    }
    else if (dict instanceof PDFArray) for (let i = 0; i < dict.size(); i++) {
      const n = fix(dict.get(i));
      if (n) dict.set(i, n);
    }
  };
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (obj instanceof PDFStream) {
      const type = obj.dict.get(PDFName.of('Type'));
      if (type === PDFName.of('XRef') || type === PDFName.of('ObjStm')) continue;
      const enc = aesEncryptData(fk, obj.getContents());
      encStrings(obj);
      obj.dict.set(PDFName.of('Length'), PDFNumber.of(enc.length));
      ctx.assign(ref, PDFRawStream.of(obj.dict, enc));
    } else encStrings(obj);
  }

  const hexStr = (b: Uint8Array) => PDFHexString.of(hex(b));
  const stdCF = ctx.obj({ AuthEvent: 'DocOpen', CFM: 'AESV3', Length: 32 });
  const encDict = ctx.obj({
    Filter: 'Standard', V: 5, R: 6, Length: 256, P,
    CF: { StdCF: stdCF }, StmF: 'StdCF', StrF: 'StdCF',
    O: hexStr(O), U: hexStr(U), OE: hexStr(OE), UE: hexStr(UE), Perms: hexStr(Perms), EncryptMetadata: true,
  });
  ctx.trailerInfo.Encrypt = ctx.register(encDict);
  const id = hexStr(rand(16));
  ctx.trailerInfo.ID = ctx.obj([id, id]);
  return doc.save({ useObjectStreams: false });
}

/** Wrap the final bytes in the protection a tab was opened with, if any. */
export const applyProtection = (bytes: Uint8Array, prot?: Protection | null) => (prot ? encryptPdf(bytes, prot) : Promise.resolve(bytes));
