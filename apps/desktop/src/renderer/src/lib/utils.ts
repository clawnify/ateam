import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Joins class names, letting a later Tailwind class override an earlier one. */
export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}
