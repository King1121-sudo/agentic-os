import type { ReactNode } from 'react';

export function JarvisPanel({
  children,
  title,
  eyebrow,
  count,
  actions,
  className = '',
}: {
  children: ReactNode;
  title?: string;
  eyebrow?: string;
  count?: number | string;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <section className={`jarvis-panel ${className}`.trim()}>
      {(title || eyebrow || actions) && (
        <header className="jarvis-panel-head">
          <div>
            {eyebrow && <div className="jarvis-eyebrow">{eyebrow}</div>}
            {title && (
              <h3>
                {title}
                {count !== undefined && <span className="jarvis-count">{count}</span>}
              </h3>
            )}
          </div>
          {actions && <div className="jarvis-panel-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}
