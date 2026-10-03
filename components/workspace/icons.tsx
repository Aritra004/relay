import type { SVGProps } from "react";
import featherIcons from "feather-icons/dist/icons.json";

type IconName =
  | "grid"
  | "search"
  | "plus"
  | "arrow"
  | "close"
  | "chevron"
  | "filter"
  | "help"
  | "monitor"
  | "check"
  | "check-circle"
  | "cloud-off"
  | "refresh"
  | "alert-circle"
  | "person";

const iconNames = {
  grid: "grid",
  search: "search",
  plus: "plus",
  arrow: "arrow-right",
  close: "x",
  chevron: "chevron-down",
  filter: "sliders",
  help: "help-circle",
  monitor: "monitor",
  check: "check",
  "check-circle": "check-circle",
  "cloud-off": "cloud-off",
  refresh: "refresh-cw",
  "alert-circle": "alert-circle",
  person: "user",
} satisfies Record<IconName, keyof typeof featherIcons>;

type IconProps = Omit<
  SVGProps<SVGSVGElement>,
  "children" | "dangerouslySetInnerHTML"
> & { name: IconName };

export function Icon({ name, className, ...props }: IconProps) {
  const featherName = iconNames[name];

  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={`feather feather-${featherName}${className ? ` ${className}` : ""}`}
      {...props}
      // SVG markup comes only from the installed Feather package.
      dangerouslySetInnerHTML={{ __html: featherIcons[featherName] }}
    />
  );
}

export function RelayMark() {
  return (
    <svg
      width="26"
      height="26"
      viewBox="0 0 26 26"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M5 7h10a5 5 0 0 1 0 10H5m10-10v15M5 3v19"
        stroke="currentColor"
        strokeWidth="2.5"
      />
      <circle cx="5" cy="7" r="2.5" fill="currentColor" />
    </svg>
  );
}
