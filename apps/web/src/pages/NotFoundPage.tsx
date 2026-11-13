import React from 'react';

interface NotFoundPageProps {
  path: string;
  onNavigate: (to: string) => void;
}

export function NotFoundPage({ path, onNavigate }: NotFoundPageProps): React.JSX.Element {
  return (
    <section className="card" style={{ textAlign: 'center', padding: 'var(--space-10) var(--space-6)' }}>
      <h1 style={{ marginTop: 0 }}>Page Not Found</h1>
      <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>
        The route <code>{path}</code> does not exist in CrewMesh.
      </p>
      <div style={{ display: 'flex', justifyContent: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-primary" onClick={() => onNavigate('/board')}>
          Go to Team Board
        </button>
        <button type="button" className="btn btn-secondary" onClick={() => onNavigate('/')}>
          Return Home
        </button>
      </div>
    </section>
  );
}
