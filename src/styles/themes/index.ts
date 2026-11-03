import { darkTheme } from "./dark";
import { lightTheme } from "./light";
import type { ThemeDefinition } from "./schema";

export { darkTheme, lightTheme };
export { AVATAR_COLOR_COUNT, THEME_TOKENS } from "./schema";
export type { ThemeDefinition, ThemeToken } from "./schema";

export const builtInThemes: Record<"light" | "dark", ThemeDefinition> = {
  light: lightTheme,
  dark: darkTheme,
};
