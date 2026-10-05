/** A PDF attachment tile (composer preview + sent user bubble): PDFs have no
 *  thumbnail, so show a labelled chip instead of an <img>. */
export function PdfChip({ name }: { name?: string }) {
  return (
    <div className="av-pdf-chip" title={name || 'PDF'}>
      <span className="av-pdf-chip-badge">PDF</span>
      {name ? <span className="av-pdf-chip-name">{name}</span> : null}
    </div>
  );
}
