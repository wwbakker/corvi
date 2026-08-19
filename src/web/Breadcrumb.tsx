/** The one navigation element: the app mark, then where you are, with everything above the last
 * step being a link back. Replaces both the page title and the old "← Changes" button. */
export function Breadcrumb({ trail, onHome }: { trail?: string[]; onHome: () => void }) {
  const steps = trail ?? [];
  return (
    <nav className="crumbs">
      <img src="/icons/favicon-32.png" alt="" width={22} height={22} onClick={onHome} />
      {steps.length === 0 ? (
        <span className="current">Changes</span>
      ) : (
        <a
          href="/"
          onClick={(e) => {
            e.preventDefault(); // keep it a client-side navigation, but a real link to open in a tab
            onHome();
          }}
        >
          Changes
        </a>
      )}
      {steps.map((step, i) => (
        <span key={step} className={i === steps.length - 1 ? "current" : ""}>
          <span className="sep">/</span>
          {step}
        </span>
      ))}
    </nav>
  );
}
