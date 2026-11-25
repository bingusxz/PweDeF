// Certificate-based digital signatures (PAdES-style "adbe.pkcs7.detached"), done offline.
//   signPdf       - signs a PDF with a certificate from a .pfx / .p12 file
//   verifySignatures - checks every signature in a PDF: is it intact, who signed, was the file changed afterwards
//   createSelfSigned - makes a personal certificate (Adobe shows these as "identity not verified", which is expected)
// Limits: RSA keys only. A PDF that is already signed can't be signed again here, because that would break the earlier
// signature (this app rewrites the file instead of appending to it).
import forge from 'node-forge';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString, StandardFonts } from 'pdf-lib';
import { winAnsiSafe } from './util';

const SIG_BYTES = 14000; // room reserved for the signature (a certificate chain plus the signature itself)
const MAX_BYTES = 90 * 1024 * 1024;

export interface Credentials {
  cert: forge.pki.Certificate;
  key: forge.pki.rsa.PrivateKey;
  chain: forge.pki.Certificate[];
  name: string;
}

export interface SignOptions {
  reason?: string;
  location?: string;
  contact?: string;
  /** a visible signature box: page (0-based) and rectangle in page units, origin top-left */
  visible?: { page: number; x: number; y: number; w: number; h: number };
  signedAt?: Date;
}

const bin = (u: Uint8Array) => {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return s;
};
const unbin = (s: string) => {
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
};
const cn = (a: forge.pki.Certificate['subject']) => String(a.getField('CN')?.value || a.getField('O')?.value || 'Unknown');

// ------------------------------------------------------------------ certificates

/** Opens a .pfx / .p12 file. Throws a plain-language error when the password is wrong or the file has no usable key. */
export function loadPfx(bytes: Uint8Array, password: string): Credentials {
  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(bin(bytes)), false, password);
  } catch (e: any) {
    if (/mac|password|decrypt/i.test(String(e?.message))) throw new Error("That password doesn't open this certificate file.");
    throw new Error('This is not a readable certificate file (.pfx or .p12).');
  }
  const keyBags = [
    ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] || []),
    ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || []),
  ];
  const key = keyBags.map((b) => b.key).find(Boolean) as forge.pki.rsa.PrivateKey | undefined;
  if (!key || !(key as any).n) throw new Error('This certificate has no RSA signing key. Only RSA certificates are supported.');
  const certs = (p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || []).map((b) => b.cert).filter(Boolean) as forge.pki.Certificate[];
  const mine = certs.find((c) => (c.publicKey as forge.pki.rsa.PublicKey).n?.compareTo(key.n) === 0);
  if (!mine) throw new Error('The certificate file has a key but no matching certificate.');
  return { cert: mine, key, chain: certs.filter((c) => c !== mine), name: cn(mine.subject) };
}

/** A personal certificate for signing. Returns the .pfx file bytes. */
export function createSelfSigned(o: { name: string; org?: string; email?: string; years?: number; password: string }): Uint8Array {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01' + forge.util.bytesToHex(forge.random.getBytesSync(8));
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + (o.years || 5) * 365 * 24 * 3600 * 1000);
  const attrs: forge.pki.CertificateField[] = [{ name: 'commonName', value: o.name }];
  if (o.org) attrs.push({ name: 'organizationName', value: o.org });
  if (o.email) attrs.push({ name: 'emailAddress', value: o.email });
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, nonRepudiation: true },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], o.password, { algorithm: '3des', friendlyName: o.name });
  return unbin(forge.asn1.toDer(p12).getBytes());
}

// ------------------------------------------------------------------ signing

const pad10 = (n: number) => String(n).padStart(10, '0');
const PH = 9999999999;

export async function signPdf(bytes: Uint8Array, cred: Credentials, o: SignOptions = {}): Promise<Uint8Array> {
  if (bytes.length > MAX_BYTES) throw new Error('This PDF is too large to sign here (over 90 MB).');
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = doc.context;
  if (existingSignatureDicts(doc).length) throw new Error('This PDF is already signed. Signing it again would break the earlier signature, so sign a copy that has no signatures.');

  const when = o.signedAt || new Date();
  const text = (s: string) => PDFHexString.fromText(s);
  const sigDict = ctx.obj({
    Type: 'Sig',
    Filter: 'Adobe.PPKLite',
    SubFilter: 'adbe.pkcs7.detached',
    ByteRange: [0, PH, PH, PH],
    Contents: PDFHexString.of('0'.repeat(SIG_BYTES * 2)),
    M: PDFString.fromDate(when),
    Name: text(cred.name),
    ...(o.reason ? { Reason: text(o.reason) } : {}),
    ...(o.location ? { Location: text(o.location) } : {}),
    ...(o.contact ? { ContactInfo: text(o.contact) } : {}),
  });
  const sigRef = ctx.register(sigDict);

  // the signature field: a box on the page, or an invisible one
  const pageIndex = o.visible ? Math.min(Math.max(0, o.visible.page), doc.getPageCount() - 1) : 0;
  const page = doc.getPage(pageIndex);
  const H = page.getSize().height;
  const r = o.visible ? [o.visible.x, H - o.visible.y - o.visible.h, o.visible.x + o.visible.w, H - o.visible.y] : [0, 0, 0, 0];
  const w = r[2] - r[0], h = r[3] - r[1];
  const widget: Record<string, any> = { Type: 'Annot', Subtype: 'Widget', FT: 'Sig', Rect: r, V: sigRef, T: PDFString.of('Signature1'), F: 132, P: page.ref };
  if (o.visible && w > 4 && h > 4) {
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const esc = (s: string) => winAnsiSafe(s).replace(/([\\()])/g, '\\$1');
    const size = Math.max(5, Math.min(9, h / 5));
    const lines = [`Digitally signed by ${cred.name}`, `Date: ${when.toLocaleString()}`, ...(o.reason ? [`Reason: ${o.reason}`] : []), ...(o.location ? [`Location: ${o.location}`] : [])];
    const content =
      `q 0.97 0.98 1 rg 0 0 ${w} ${h} re f 0.25 0.35 0.75 RG 1 w 0.5 0.5 ${w - 1} ${h - 1} re S Q\n` +
      `BT /F1 ${size} Tf 0 g ${4} ${h - size - 3} Td ${size * 1.25} TL ${lines.map((l) => `(${esc(l)}) Tj T*`).join(' ')} ET`;
    const ap = ctx.register(ctx.stream(content, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, w, h], Resources: { Font: { F1: font.ref } } }));
    widget.AP = { N: ap };
  }
  const widgetRef = ctx.register(ctx.obj(widget));
  page.node.addAnnot(widgetRef);

  let acro = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  if (!acro) {
    acro = ctx.obj({ Fields: [] }) as PDFDict;
    doc.catalog.set(PDFName.of('AcroForm'), ctx.register(acro));
  }
  let fields = acro.lookupMaybe(PDFName.of('Fields'), PDFArray);
  if (!fields) {
    fields = ctx.obj([]) as PDFArray;
    acro.set(PDFName.of('Fields'), fields);
  }
  fields.push(widgetRef);
  acro.set(PDFName.of('SigFlags'), PDFNumber.of(3));

  // plain objects only: the signature dictionary must sit at a fixed place in the file
  const out = await doc.save({ useObjectStreams: false });

  // find the placeholders and fill in the real byte ranges
  const text8 = new TextDecoder('latin1').decode(out);
  const brAt = text8.lastIndexOf('/ByteRange [');
  const cAt = text8.indexOf('/Contents <', brAt);
  if (brAt < 0 || cAt < 0) throw new Error('Could not place the signature in the file.');
  const hexStart = cAt + '/Contents '.length; // the "<"
  const hexEnd = out.indexOf(0x3e /* > */, hexStart); // the ">"
  const range = [0, hexStart, hexEnd + 1, out.length - (hexEnd + 1)];
  const oldBr = text8.slice(brAt, text8.indexOf(']', brAt) + 1);
  // keep pdf-lib's own spacing: only the three placeholder numbers change, to same-width values
  const fill = [range[1], range[2], range[3]];
  const brText = oldBr.replace(new RegExp(String(PH), 'g'), () => pad10(fill.shift() as number));
  if (oldBr.length !== brText.length || fill.length) throw new Error('Signature placeholder had an unexpected size.');
  out.set(unbin(brText), brAt);

  const signed = new Uint8Array(range[1] + range[3]);
  signed.set(out.subarray(0, range[1]), 0);
  signed.set(out.subarray(range[2]), range[1]);

  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(bin(signed));
  p7.addCertificate(cred.cert);
  for (const c of cred.chain) p7.addCertificate(c);
  p7.addSigner({
    key: cred.key,
    certificate: cred.cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: when as any },
    ],
  });
  p7.sign({ detached: true });
  const der = forge.asn1.toDer(p7.toAsn1()).getBytes();
  if (der.length > SIG_BYTES) throw new Error('The certificate chain is too large to fit in a signature.');
  out.set(unbin(forge.util.bytesToHex(der).padEnd(SIG_BYTES * 2, '0')), hexStart + 1);
  return out;
}

// ------------------------------------------------------------------ checking

interface SigDict {
  dict: PDFDict;
  field: string;
}

function existingSignatureDicts(doc: PDFDocument): SigDict[] {
  const out: SigDict[] = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    if (obj.get(PDFName.of('ByteRange')) && obj.get(PDFName.of('Contents')) && /Sig|DocTimeStamp/.test(String(obj.get(PDFName.of('Type')) || 'Sig'))) {
      out.push({ dict: obj, field: '' });
    }
  }
  return out;
}

export interface SigReport {
  signer: string;
  issuer: string;
  signedAt: Date | null;
  reason?: string;
  location?: string;
  selfSigned: boolean;
  /** valid = intact and covers the whole file; modified = intact but the file changed after signing; invalid = broken */
  status: 'valid' | 'modified' | 'invalid';
  notes: string[];
}

const OID = { messageDigest: '1.2.840.113549.1.9.4', signingTime: '1.2.840.113549.1.9.5' };
const HASH: Record<string, () => forge.md.MessageDigest> = {
  '1.3.14.3.2.26': () => forge.md.sha1.create(),
  '2.16.840.1.101.3.4.2.1': () => forge.md.sha256.create(),
  '2.16.840.1.101.3.4.2.2': () => forge.md.sha384.create(),
  '2.16.840.1.101.3.4.2.3': () => forge.md.sha512.create(),
};

const pdfText = (d: PDFDict, key: string) => {
  const v = d.lookup(PDFName.of(key));
  return v instanceof PDFHexString ? v.decodeText() : v instanceof PDFString ? v.decodeText() : undefined;
};

export async function verifySignatures(bytes: Uint8Array): Promise<SigReport[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
  const reports: SigReport[] = [];
  for (const { dict } of existingSignatureDicts(doc)) {
    const notes: string[] = [];
    const rep: SigReport = { signer: 'Unknown', issuer: '', signedAt: null, reason: pdfText(dict, 'Reason'), location: pdfText(dict, 'Location'), selfSigned: false, status: 'invalid', notes };
    try {
      const br = (dict.lookup(PDFName.of('ByteRange')) as PDFArray).asArray().map((n) => (n as PDFNumber).asNumber());
      const contents = dict.lookup(PDFName.of('Contents')) as PDFHexString;
      const raw = contents.asBytes();
      // the signature is DER followed by zero padding: read its true length from its header
      let total = raw.length;
      if (raw[0] === 0x30) {
        if (raw[1] & 0x80) {
          const n = raw[1] & 0x7f;
          let len = 0;
          for (let i = 0; i < n; i++) len = len * 256 + raw[2 + i];
          total = 2 + n + len;
        } else total = 2 + raw[1];
      }
      const p7asn1 = forge.asn1.fromDer(bin(raw.subarray(0, total)));
      const p7 = forge.pkcs7.messageFromAsn1(p7asn1) as any;
      const certs: forge.pki.Certificate[] = p7.certificates || [];

      // signer info: the last element of SignedData
      const signedData = (p7asn1.value[1] as forge.asn1.Asn1).value[0] as forge.asn1.Asn1;
      const signerInfo = ((signedData.value[signedData.value.length - 1] as forge.asn1.Asn1).value[0]) as forge.asn1.Asn1;
      const sv = signerInfo.value as forge.asn1.Asn1[];
      const serialHex = forge.util.bytesToHex(((sv[1].value as forge.asn1.Asn1[])[1].value as string));
      const digestOid = forge.asn1.derToOid((sv[2].value as forge.asn1.Asn1[])[0].value as string);
      const attrsNode = sv.find((n) => n.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC && n.type === 0);
      const sigNode = [...sv].reverse().find((n) => n.tagClass === forge.asn1.Class.UNIVERSAL && n.type === forge.asn1.Type.OCTETSTRING);
      const cert = certs.find((c) => c.serialNumber.toLowerCase() === serialHex.replace(/^0+(?=.)/, '').toLowerCase()) || certs.find((c) => c.serialNumber.toLowerCase() === serialHex.toLowerCase()) || certs[0];
      if (!cert || !sigNode || !attrsNode || !HASH[digestOid]) throw new Error('unsupported signature format');
      rep.signer = cn(cert.subject);
      rep.issuer = cn(cert.issuer);
      rep.selfSigned = cert.isIssuer(cert);

      // 1) does the file still hash to what was signed?
      const md = HASH[digestOid]();
      const pieces: [number, number][] = [[br[0], br[1]], [br[2], br[3]]];
      for (const [s, l] of pieces) for (let i = s; i < s + l; i += 0x8000) md.update(bin(bytes.subarray(i, Math.min(s + l, i + 0x8000))));
      const fileDigest = md.digest().getBytes();
      let storedDigest = '';
      for (const a of attrsNode.value as forge.asn1.Asn1[]) {
        const oid = forge.asn1.derToOid((a.value as forge.asn1.Asn1[])[0].value as string);
        const val = ((a.value as forge.asn1.Asn1[])[1].value as forge.asn1.Asn1[])[0];
        if (oid === OID.messageDigest) storedDigest = val.value as string;
        if (oid === OID.signingTime) rep.signedAt = val.type === forge.asn1.Type.UTCTIME ? forge.asn1.utcTimeToDate(val.value as string) : forge.asn1.generalizedTimeToDate(val.value as string);
      }
      const digestOk = storedDigest === fileDigest;

      // 2) was the signed attribute block really signed with the certificate's key?
      const set = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, attrsNode.value as forge.asn1.Asn1[]);
      const am = HASH[digestOid]();
      am.update(forge.asn1.toDer(set).getBytes());
      let sigOk = false;
      try {
        sigOk = (cert.publicKey as forge.pki.rsa.PublicKey).verify(am.digest().getBytes(), sigNode.value as string);
      } catch {
        sigOk = false;
      }

      const whole = br[2] + br[3] >= bytes.length - 2;
      if (!digestOk) notes.push('The document was changed after it was signed.');
      if (!sigOk) notes.push('The signature itself does not match the certificate.');
      if (digestOk && sigOk && !whole) notes.push('The signed part is unchanged, but more was added to the file after signing.');
      if (rep.selfSigned) notes.push("The signer's identity is not confirmed by a trusted authority (self-signed certificate).");
      if (rep.signedAt && (rep.signedAt < cert.validity.notBefore || rep.signedAt > cert.validity.notAfter)) notes.push('The certificate was not valid on the signing date.');
      rep.status = !digestOk || !sigOk ? 'invalid' : whole ? 'valid' : 'modified';
    } catch (e: any) {
      notes.push('This signature could not be read: ' + (e?.message || e));
    }
    reports.push(rep);
  }
  return reports;
}

export const hasSignatures = async (bytes: Uint8Array) => existingSignatureDicts(await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true })).length > 0;
