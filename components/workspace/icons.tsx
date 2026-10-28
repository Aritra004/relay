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
  | "person"
  | "hard-drive"
  | "cloud";

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
  "hard-drive": "hard-drive",
  cloud: "cloud",
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

