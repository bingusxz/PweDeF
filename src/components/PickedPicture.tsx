import { useState } from 'react';
import { Modal } from './Modal';
import { ocrImage } from '../lib/ocr';

/** A picture lifted from the page (usually a signature): save it for reuse, place a copy, or read the text in it. */
export function PickedPicture({ pic, onClose, onSave, onPlace, onDelete }: { pic: { dataUrl: string; w: number; h: number }; onClose: () => void; onSave: () => void; onPlace: () => void; onDelete: () => void }) {
  const [reading, setReading] = useState(false);
  const [read, setRead] = useState<{ text: string; confidence: number } | null>(null);
  const [err, setErr] = useState('');
  const doRead = async () => {
    setReading(true);
    setErr('');
    try {
      setRead(await ocrImage(pic.dataUrl));
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setReading(false);
    }
  };
  return (
    <Modal
      title="Picture picked up"
      width={480}
      onClose={onClose}
      footer={
        <>
          <button className="danger" onClick={onDelete} title="Remove the original picture from the page">
            Delete original
          </button>
          <button onClick={onPlace}>Place a copy…</button>
          <button className="primary" onClick={onSave}>
            Save as my signature
          </button>
        </>
      }
    >
      <div className="picked-preview">
        <img src={pic.dataUrl} alt="The picture you picked up" />
      </div>
      <div className="picked-read">
        <button disabled={reading} onClick={doRead}>
          {reading ? 'Reading…' : 'Read the text in it'}
        </button>
        {read && (
          <span>
            {read.text ? (
              <>
                <b className="picked-text">{read.text}</b> <small className="muted">({Math.round(read.confidence)}% sure{read.confidence < 60 ? ': handwriting is often misread' : ''})</small>
              </>
            ) : (
              <span className="muted">No text found. Handwritten signatures usually can't be read.</span>
            )}
          </span>
        )}
        {err && <span className="merge-err">{err}</span>}
      </div>
      <p className="muted">
        The white background has been made see-through. “Save as my signature” adds it to Sign, then Saved. “Place a copy” lets you click where to put it. The original stays on the page until you press “Delete original”, which removes it when you save (Undo brings it back).
      </p>
    </Modal>
  );
}
