import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function Svg({ children, ...props }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      width="16"
      height="16"
      aria-hidden
      {...props}
    >
      {children}
    </svg>
  );
}

export function ChevronRight(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 4l4 4-4 4" />
    </Svg>
  );
}

export function ChevronDown(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 6l4 4 4-4" />
    </Svg>
  );
}

export function Copy(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="5" y="5" width="8" height="8" rx="1.5" />
      <path d="M3 11V4.5A1.5 1.5 0 0 1 4.5 3H11" />
    </Svg>
  );
}

export function Check(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 8.5l3 3 7-7" />
    </Svg>
  );
}

export function Sun(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.5v1.25M8 13.25v1.25M2.7 2.7l.9.9M12.4 12.4l.9.9M1.5 8h1.25M13.25 8h1.25M2.7 13.3l.9-.9M12.4 3.6l.9-.9" />
    </Svg>
  );
}

export function Moon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M13.5 9.5A5.5 5.5 0 1 1 6.5 2.5a4.5 4.5 0 0 0 7 7z" />
    </Svg>
  );
}

export function Search(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5l3 3" />
    </Svg>
  );
}

export function Play(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.5 3.5v9l8-4.5-8-4.5z" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function ExternalLink(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9.5 3h3.5v3.5" />
      <path d="M13 3l-5 5" />
      <path d="M12 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h2.5" />
    </Svg>
  );
}

export function Inbox(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2.5 9.5L4 4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1l1.5 5.5" />
      <path d="M2.5 9.5V12a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V9.5" />
      <path d="M2.5 9.5h3l1 1.5h3l1-1.5h3" />
    </Svg>
  );
}

export function X(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Svg>
  );
}

export function ArrowRight(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 8h10M9 4l4 4-4 4" />
    </Svg>
  );
}

export function ArrowLeft(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M13 8H3M7 12L3 8l4-4" />
    </Svg>
  );
}

export function Send(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M14 2L7.5 8.5" />
      <path d="M14 2l-4.5 12-2.5-5.5L1.5 6.5 14 2z" />
    </Svg>
  );
}

export function Sparkles(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5.5 2.5l1 2.5 2.5 1-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1 1-2.5z" />
      <path d="M11.5 8l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8z" />
    </Svg>
  );
}

export function BookOpen(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2 3h4a2 2 0 0 1 2 2v8a2 2 0 0 0-2-2H2V3z" />
      <path d="M14 3h-4a2 2 0 0 0-2 2v8a2 2 0 0 1 2-2h4V3z" />
    </Svg>
  );
}

export function StopCircle(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="6" />
      <rect x="6" y="6" width="4" height="4" rx="0.5" />
    </Svg>
  );
}

export function Download(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 2v8M4.5 7l3.5 3.5L11.5 7" />
      <path d="M2.5 12.5h11" />
    </Svg>
  );
}

export function Refresh(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M13 3v3.5h-3.5" />
      <path d="M3 13v-3.5h3.5" />
      <path d="M12.5 6.5A5 5 0 0 0 4 5M3.5 9.5A5 5 0 0 0 12 11" />
    </Svg>
  );
}
