interface Props {
  mode: string;
  modelId: string;
  repoUrl: string;
  inspectorCount: number;
  onToggleInspector: () => void;
}

export function TopBar({ mode, modelId, repoUrl, inspectorCount, onToggleInspector }: Props) {
  return (
    <header className="topbar">
      <div className="topbar__mark">
        <span className="topbar__name">Caliper</span>
        <span className="topbar__tagline">assistive triage console</span>
      </div>
      <div className="topbar__spacer" />
      <div className="topbar__meta">
        <span className="topbar__mode" title="Where the API handlers are executing">
          <span className="topbar__dot" aria-hidden="true" />
          {mode}
        </span>
        <span className="topbar__model" title="Provider producing the assessment">{modelId}</span>
        <button
          type="button"
          className="topbar__link topbar__button"
          onClick={onToggleInspector}
          title="Read the request and response envelopes this session exchanged"
        >
          API ({inspectorCount})
        </button>
        <a className="topbar__link" href={repoUrl} target="_blank" rel="noreferrer">
          source
        </a>
      </div>
    </header>
  );
}
