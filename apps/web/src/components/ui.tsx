import { useI18n } from "../i18n/index.js";

import type { ReactNode } from "react";

/**
 * CSS-only hover/focus tooltip. Keyboard-reachable (tabIndex) and mirrored
 * into aria-label so screen readers get the tip without the visual bubble.
 */
export function Tooltip({ tip, children }: { tip: string; children: ReactNode }) {
  return (
    <span className="tip-wrap" tabIndex={0} aria-label={tip}>
      {children}
      <span role="tooltip" className="tip-bubble">
        {tip}
      </span>
    </span>
  );
}

export function Card({
  title,
  count,
  action,
  children,
  className
}: {
  title?: string;
  count?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`card${className ? ` ${className}` : ""}`}>
      {(title || action) && (
        <div className="card-head">
          {title && <h3>{title}</h3>}
          {count !== undefined && <span className="count">{count}</span>}
          {action && <span className="head-action">{action}</span>}
        </div>
      )}
      {children}
    </div>
  );
}

export function Button({
  children,
  onClick,
  variant = "secondary",
  size,
  disabled,
  type = "button",
  title,
  ariaLabel
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm";
  disabled?: boolean;
  type?: "button" | "submit";
  title?: string;
  ariaLabel?: string;
}) {
  const cls = [
    "btn",
    variant === "danger" ? "btn-secondary btn-danger" : `btn-${variant}`,
    size === "sm" ? "btn-sm" : ""
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button type={type} className={cls} onClick={onClick} disabled={disabled} title={title} aria-label={ariaLabel}>
      {children}
    </button>
  );
}

export function Badge({
  children,
  tone = "neutral",
  dot = true
}: {
  children: ReactNode;
  tone?: "neutral" | "ok" | "warn" | "err" | "accent";
  dot?: boolean;
}) {
  const cls = tone === "neutral" ? "badge" : `badge ${tone}`;
  return (
    <span className={cls}>
      {dot && <span className="dot" />}
      {children}
    </span>
  );
}

/** An optional call-to-action on an empty state. `onClick` runs an in-app
 * action (focus a composer, navigate a view); `href` is for a real link. */
export type EmptyAction = {
  label: ReactNode;
  onClick?: () => void;
  href?: string;
  icon?: ReactNode;
};

function EmptyCta({ action }: { action: EmptyAction }) {
  const inner = (
    <>
      {action.icon}
      {action.label}
    </>
  );
  return (
    <div className="empty-action">
      {action.href ? (
        <a className="btn btn-primary btn-sm" href={action.href}>
          {inner}
        </a>
      ) : (
        <Button variant="primary" size="sm" onClick={action.onClick}>
          {inner}
        </Button>
      )}
    </div>
  );
}

export function Empty({
  children,
  hint,
  icon,
  tone = "neutral",
  action
}: {
  children: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  tone?: "neutral" | "err";
  action?: EmptyAction;
}) {
  const glyph = icon ?? <Icon.inbox />;
  return (
    <div className={tone === "err" ? "empty err" : "empty"}>
      <div className="empty-ic">{glyph}</div>
      <div className="empty-title">{children}</div>
      {hint && <div className="empty-hint">{hint}</div>}
      {action && <EmptyCta action={action} />}
    </div>
  );
}

function Spinner() {
  return <span className="spinner" aria-label="loading" />;
}

export function Stat({ value, label, icon }: { value: ReactNode; label: string; icon?: ReactNode }) {
  const body = (
    <div className="stat">
      <span className="value">{value}</span>
      <span className="label">{label}</span>
    </div>
  );
  if (!icon) {
    return body;
  }
  return (
    <div className="stat-card">
      <span className="stat-ic" aria-hidden="true">
        {icon}
      </span>
      {body}
    </div>
  );
}

/** Renders query state uniformly: spinner while loading, warm empty/error state otherwise.
 * The empty state optionally carries a CTA (`emptyAction`) and a warmer label/icon so a
 * fresh, data-empty install can guide the user toward their first action. */
export function AsyncBlock({
  loading,
  error,
  empty,
  emptyLabel,
  emptyIcon,
  emptyAction,
  children
}: {
  loading: boolean;
  error?: unknown;
  empty?: boolean;
  emptyLabel?: ReactNode;
  emptyIcon?: ReactNode;
  emptyAction?: EmptyAction;
  children: ReactNode;
}) {
  const { t } = useI18n();
  if (loading) {
    return (
      <div className="empty">
        <Spinner />
      </div>
    );
  }
  if (error) {
    return (
      <Empty tone="err" icon={<Icon.alert />} hint={t("common.loadFailedHint")}>
        {t("common.loadFailed")}
      </Empty>
    );
  }
  if (empty) {
    return (
      <Empty icon={emptyIcon} action={emptyAction}>
        {emptyLabel ?? t("common.empty")}
      </Empty>
    );
  }
  return <>{children}</>;
}

// ── Icons (16px, currentColor) ───────────────────────────────

type IconProps = { className?: string };
const base = (p: IconProps, d: ReactNode) => (
  <svg
    className={p.className ?? "nav-icon"}
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable={false}
  >
    {d}
  </svg>
);

export const Icon = {
  activity: (p: IconProps) => base(p, <path d="M3 12h4l3 8 4-16 3 8h4" />),
  calendar: (p: IconProps) =>
    base(
      p,
      <>
        <rect x="3" y="4" width="18" height="17" rx="2" />
        <path d="M3 9h18M8 2v4M16 2v4" />
      </>
    ),
  chat: (p: IconProps) => base(p, <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V6a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" />),
  home: (p: IconProps) => base(p, <path d="M3 11l9-8 9 8M5 10v10h14V10" />),
  note: (p: IconProps) =>
    base(
      p,
      <>
        <path d="M5 3h10l4 4v14H5z" />
        <path d="M14 3v5h5M8 13h8M8 17h6" />
      </>
    ),
  bell: (p: IconProps) => base(p, <path d="M6 9a6 6 0 0 1 12 0c0 7 3 7 3 7H3s3 0 3-7M9 20a3 3 0 0 0 6 0" />),
  plug: (p: IconProps) => base(p, <path d="M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0zM12 17v5" />),
  task: (p: IconProps) =>
    base(
      p,
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M8 12l3 3 5-6" />
      </>
    ),
  tool: (p: IconProps) =>
    base(p, <path d="M14 7a4 4 0 0 0-5 5l-6 6 2 2 6-6a4 4 0 0 0 5-5l-2 2-2-2 2-2z" />),
  settings: (p: IconProps) =>
    base(
      p,
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.3.9a7 7 0 0 0-1.7-1L14.5 2h-5l-.4 2.5a7 7 0 0 0-1.7 1L5 4.6l-2 3.4L5 9.5a7 7 0 0 0 0 2L3 13l2 3.4 2.3-.9a7 7 0 0 0 1.7 1l.4 2.5h5l.4-2.5a7 7 0 0 0 1.7-1l2.3.9 2-3.4-2-1.5a7 7 0 0 0 .1-1z" />
      </>
    ),
  check: (p: IconProps) => base({ className: p.className }, <path d="M5 12l5 5L20 7" />),
  send: (p: IconProps) => base(p, <path d="M4 12l16-8-6 16-3-6-7-2z" />),
  plus: (p: IconProps) => base(p, <path d="M12 5v14M5 12h14" />),
  trash: (p: IconProps) => base(p, <path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14" />),
  mic: (p: IconProps) =>
    base(
      p,
      <>
        <rect x="9" y="3" width="6" height="11" rx="3" />
        <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
      </>
    ),
  volume: (p: IconProps) => base(p, <path d="M4 9v6h4l5 4V5L8 9zM16 9a3 3 0 0 1 0 6M18.5 7a6 6 0 0 1 0 10" />),
  chart: (p: IconProps) => base(p, <path d="M4 20V4M4 20h16M8 16v-5M12 16V8M16 16v-3" />),
  shield: (p: IconProps) => base(p, <path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z" />),
  brain: (p: IconProps) =>
    base(p, <path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-1 5 3 3 0 0 0 2 4 3 3 0 0 0 5 1V4a2 2 0 0 0-3 0M15 4a3 3 0 0 1 3 3 3 3 0 0 1 1 5 3 3 0 0 1-2 4 3 3 0 0 1-5 1" />),
  mail: (p: IconProps) =>
    base(
      p,
      <>
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="M3 7l9 6 9-6" />
      </>
    ),
  inbox: (p: IconProps) =>
    base(
      p,
      <>
        <path d="M3 12h5l2 3h4l2-3h5" />
        <path d="M5 5h14l2 7v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5z" />
      </>
    ),
  alert: (p: IconProps) =>
    base(
      p,
      <>
        <path d="M12 3l9 16H3z" />
        <path d="M12 10v4M12 17v.5" />
      </>
    )
};
