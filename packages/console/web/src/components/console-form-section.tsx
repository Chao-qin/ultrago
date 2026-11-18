import type { ReactNode } from 'react';

export function ConsoleFormSection({ title, description, children }: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="console-form-section" aria-label={title}>
      <header><span className="console-form-section-mark" aria-hidden="true" /><div><h3>{title}</h3>{description && <p>{description}</p>}</div></header>
      <div className="console-form-section-fields">{children}</div>
    </section>
  );
}
