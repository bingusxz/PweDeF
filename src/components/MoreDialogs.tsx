// Dialogs for password protection and the page-layout tools (crop, n-up, headers and footers).
import { useState } from 'react';
import { Modal } from './Modal';
import { ALL_PERMISSIONS, type Permissions, type Protection } from '../lib/pdfCrypt';

/** Asks for the password of a protected file. */
export function PasswordPrompt({ name, wrong, onSubmit, onCancel }: { name: string; wrong: boolean; onSubmit: (pw: string) => void; onCancel: () => void }) {
  const [pw, setPw] = useState('');
  const [show, setShow] = useState(false);
  const go = () => pw && onSubmit(pw);
  return (
    <Modal
      title="Password needed"
      onClose={onCancel}
      width={440}
      footer={
        <button className="primary" disabled={!pw} onClick={go}>
          Open
        </button>
      }
    >
      <p className="muted">"{name}" is protected. Type its password to open it.</p>
      <label>Password</label>
      <input autoFocus type={show ? 'text' : 'password'} value={pw} autoComplete="off" onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} />
      <label className="check">
        <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> Show the password
      </label>
      {wrong && <p className="merge-err">That password is not right. Try again.</p>}
    </Modal>
  );
}

export type ExcelPdfOpts = { orientation: 'auto' | 'portrait' | 'landscape'; fitWidth: boolean };
export type ConvertKind = 'excel' | 'word' | 'images' | 'text';

const CONVERT_COPY: Record<ConvertKind, { title: string; auto: string; go: string }> = {
  excel: { title: 'Excel to PDF', auto: 'Automatic (wide sheets go landscape)', go: 'Choose files' },
  word: { title: 'Word to PDF', auto: 'As set in each document', go: 'Choose files' },
  images: { title: 'Images to PDF', auto: 'Match each picture', go: 'Choose images' },
  text: { title: 'HTML or text to PDF', auto: 'Portrait (upright)', go: 'Choose a file' },
};

/** Asked before something is turned into a PDF: which way the pages face (and for Excel, whether wide sheets shrink to fit). */
export function ConvertPdfDialog({ kind, onGo, onCancel }: { kind: ConvertKind; onGo: (o: ExcelPdfOpts) => void; onCancel: () => void }) {
  const copy = CONVERT_COPY[kind];
  const [orientation, setOrientation] = useState<ExcelPdfOpts['orientation']>('auto');
  const [fitWidth, setFitWidth] = useState(true);
  return (
    <Modal
      title={copy.title}
      onClose={onCancel}
      width={460}
      footer={
        <button className="primary" onClick={() => onGo({ orientation, fitWidth })}>
          {copy.go}
        </button>
      }
    >
      <label>Page direction</label>
      <select value={orientation} onChange={(e) => setOrientation(e.target.value as ExcelPdfOpts['orientation'])}>
        <option value="auto">{copy.auto}</option>
        <option value="portrait">Portrait (upright)</option>
        <option value="landscape">Landscape (sideways)</option>
      </select>
      {kind === 'excel' && (
        <label className="check">
          <input type="checkbox" checked={fitWidth} onChange={(e) => setFitWidth(e.target.checked)} /> Fit all columns on the page width, so nothing is cut off
        </label>
      )}
      <p className="muted">Applies to every page. The original file is not changed.</p>
    </Modal>
  );
}

const PERM_LABELS: { k: keyof Permissions; label: string }[] = [
  { k: 'print', label: 'Printing' },
  { k: 'edit', label: 'Changing the document' },
  { k: 'copy', label: 'Copying text and pictures' },
  { k: 'annotate', label: 'Adding comments and markup' },
  { k: 'fillForms', label: 'Filling in form fields' },
  { k: 'assemble', label: 'Inserting, deleting and rotating pages' },
];

export function ProtectDialog({ current, onClose, onRun }: { current: Protection | null | undefined; onClose: () => void; onRun: (p: Protection | null) => void }) {
  const [userPw, setUserPw] = useState(current?.userPassword ?? '');
  const [again, setAgain] = useState(current?.userPassword ?? '');
  const [ownerPw, setOwnerPw] = useState(current?.ownerPassword && current.ownerPassword !== current.userPassword ? current.ownerPassword : '');
  const [perms, setPerms] = useState<Permissions>(current?.permissions ?? ALL_PERMISSIONS);
  const [err, setErr] = useState('');
  const limited = PERM_LABELS.some((p) => !perms[p.k]);
  const go = () => {
    if (!userPw && !limited) return setErr('Type a password to open the file, or switch off at least one permission.');
    if (userPw !== again) return setErr('The two passwords are not the same.');
    if (limited && !ownerPw && !userPw) return setErr('To limit what people can do, set a permissions password.');
    setErr('');
    onRun({ userPassword: userPw, ownerPassword: ownerPw || userPw, permissions: { ...perms, printHighQuality: perms.print } });
  };
  return (
    <Modal
      title="Protect with a password"
      onClose={onClose}
      width={500}
      footer={
        <>
          {current && (
            <button onClick={() => onRun(null)} title="Save this file without any password">
              Remove protection
            </button>
          )}
          <button className="primary" onClick={go}>
            Protect
          </button>
        </>
      }
    >
      <p className="muted">Uses AES-256 encryption. The password is applied when you save, and it is not stored anywhere. If you forget it, nobody can recover the file.</p>
      <label>Password to open the file</label>
      <input type="password" autoComplete="new-password" value={userPw} onChange={(e) => setUserPw(e.target.value)} />
      <label>Type it again</label>
      <input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
      <p className="hint">Leave it blank if the file should open freely but with limits below.</p>
      <label>Allow people to</label>
      {PERM_LABELS.map((p) => (
        <label className="check" key={p.k}>
          <input type="checkbox" checked={perms[p.k]} onChange={(e) => setPerms({ ...perms, [p.k]: e.target.checked })} /> {p.label}
        </label>
      ))}
      {limited && (
        <>
          <label>Permissions password (needed to lift these limits)</label>
          <input type="password" autoComplete="new-password" value={ownerPw} onChange={(e) => setOwnerPw(e.target.value)} />
          <p className="hint">Some PDF programs ignore these limits. Only the password to open the file keeps people out for sure.</p>
        </>
      )}
      {err && <p className="merge-err">{err}</p>}
    </Modal>
  );
}
