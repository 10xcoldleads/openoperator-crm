"use client";

import { CSSProperties, ReactNode } from "react";
import "./GradientText.css";

type GradientTextProps = {
  children: ReactNode;
  className?: string;
  colors?: string[];
  animationSpeed?: number;
  showBorder?: boolean;
  direction?: "horizontal" | "vertical" | "diagonal";
  pauseOnHover?: boolean;
  yoyo?: boolean;
};

type GradientStyle = CSSProperties & {
  "--gradient-colors": string;
  "--gradient-speed": string;
  "--gradient-direction": string;
};

export default function GradientText({
  children,
  className = "",
  colors = ["#ef5045", "#7868ff", "#ef5045"],
  animationSpeed = 8,
  showBorder = false,
  direction = "horizontal",
  pauseOnHover = false,
  yoyo = true,
}: GradientTextProps) {
  const safeColors = colors.length >= 2 ? colors : ["#ef5045", "#7868ff", "#ef5045"];
  const style: GradientStyle = {
    "--gradient-colors": [...safeColors, safeColors[0]].join(", "),
    "--gradient-speed": `${Math.max(animationSpeed, 0.5)}s`,
    "--gradient-direction": yoyo ? "alternate" : "normal",
  };
  const classes = [
    "animated-gradient-text",
    `gradient-${direction}`,
    showBorder ? "with-border" : "",
    pauseOnHover ? "pause-on-hover" : "",
    className,
  ].filter(Boolean).join(" ");

  return <span className={classes} style={style}>
    {showBorder && <span className="gradient-overlay" aria-hidden="true" />}
    <span className="text-content">{children}</span>
  </span>;
}
