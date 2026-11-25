import mark from './folded-icon.png';
import lettering from './folded-wordmark.png';

export function LogoMark({ size = 24, title = 'PweDeF' }: { size?: number; title?: string }) {
  return <img src={mark} width={size} height={size} alt={title} className="logo-mark" />;
}

export function BrandName() {
  return <img className="painted-wordmark" src={lettering} alt="PweDeF" />;
}

export function Wordmark() {
  return (
    <span className="wordmark">
      <span className="wordmark-text"><BrandName /></span>
    </span>
  );
}
