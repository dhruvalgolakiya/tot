import type { ComponentProps } from "react";
import { buttonClass, type ButtonSize, type ButtonVariant } from "./buttonStyles";

type ButtonProps = ComponentProps<"button"> & { variant?: ButtonVariant; size?: ButtonSize };

export function Button({ variant = "secondary", size = "md", className, ...props }: ButtonProps) {
  return <button type="button" className={buttonClass(variant, size, className)} {...props} />;
}
